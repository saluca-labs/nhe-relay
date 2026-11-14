// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

#include "NheRelayComponent.h"

#include "AudioCaptureCore.h"
#include "Components/AudioComponent.h"
#include "Dom/JsonObject.h"
#include "GenericPlatform/GenericPlatformHttp.h"
#include "HttpModule.h"
#include "Interfaces/IHttpResponse.h"
#include "Kismet/GameplayStatics.h"
#include "Misc/Guid.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Sound/SoundWaveProcedural.h"

namespace
{
    constexpr float MaxClipSeconds = 30.f; // the relay refuses longer clips

    TSharedPtr<FJsonObject> EmptyMemory()
    {
        TSharedPtr<FJsonObject> M = MakeShared<FJsonObject>();
        M->SetStringField(TEXT("summary"), TEXT(""));
        M->SetArrayField(TEXT("facts"), TArray<TSharedPtr<FJsonValue>>());
        M->SetNumberField(TEXT("turn_count"), 0);
        return M;
    }

    TSharedPtr<FJsonObject> ParseObject(const FString& Text)
    {
        TSharedPtr<FJsonObject> Obj;
        TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Text);
        return FJsonSerializer::Deserialize(Reader, Obj) ? Obj : nullptr;
    }

    FString Serialize(const TSharedPtr<FJsonObject>& Obj)
    {
        FString Out;
        TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Out);
        FJsonSerializer::Serialize(Obj.ToSharedRef(), Writer);
        return Out;
    }

    void PutLE16(TArray<uint8>& B, int32 V) { B.Add(V & 0xFF); B.Add((V >> 8) & 0xFF); }
    void PutLE32(TArray<uint8>& B, int32 V) { PutLE16(B, V & 0xFFFF); PutLE16(B, (V >> 16) & 0xFFFF); }
    void PutTag(TArray<uint8>& B, const char* T) { for (int32 i = 0; i < 4; ++i) B.Add(static_cast<uint8>(T[i])); }

    /** Mono float samples to a 16-bit PCM WAV. */
    TArray<uint8> EncodeWav(const TArray<float>& Samples, int32 Rate)
    {
        TArray<uint8> B;
        const int32 DataBytes = Samples.Num() * 2;
        B.Reserve(44 + DataBytes);
        PutTag(B, "RIFF"); PutLE32(B, 36 + DataBytes); PutTag(B, "WAVE");
        PutTag(B, "fmt "); PutLE32(B, 16); PutLE16(B, 1); PutLE16(B, 1);
        PutLE32(B, Rate); PutLE32(B, Rate * 2); PutLE16(B, 2); PutLE16(B, 16);
        PutTag(B, "data"); PutLE32(B, DataBytes);
        for (float S : Samples)
        {
            const int32 V = FMath::Clamp(FMath::RoundToInt(S * 32767.f), -32768, 32767);
            PutLE16(B, V);
        }
        return B;
    }

    int32 LE16(const TArray<uint8>& B, int32 O) { return B[O] | (B[O + 1] << 8); }
    int32 LE32(const TArray<uint8>& B, int32 O) { return LE16(B, O) | (LE16(B, O + 2) << 16); }
}

UNheRelayComponent::UNheRelayComponent()
{
    PrimaryComponentTick.bCanEverTick = false;
    ScriptedLines = { TEXT("Hm, give me a moment."), TEXT("Where was I? Ask me again.") };
}

void UNheRelayComponent::BeginPlay()
{
    Super::BeginPlay();
    if (SessionId.IsEmpty())
    {
        SessionId = FString::Printf(TEXT("ue-%s"), *FGuid::NewGuid().ToString(EGuidFormats::Digits)).Left(64);
    }
    Memory = EmptyMemory();
}

void UNheRelayComponent::EndPlay(const EEndPlayReason::Type Reason)
{
    if (Capture.IsValid())
    {
        Capture->StopStream();
        Capture->CloseStream();
        Capture.Reset();
    }
    Super::EndPlay(Reason);
}

TSharedRef<IHttpRequest, ESPMode::ThreadSafe> UNheRelayComponent::NewRequest(const FString& Verb, const FString& Path) const
{
    TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Req = FHttpModule::Get().CreateRequest();
    Req->SetURL(RelayUrl + Path);
    Req->SetVerb(Verb);
    Req->SetTimeout(TimeoutSeconds);
    return Req;
}

// ---------------------------------------------------------------- turns

void UNheRelayComponent::Say(const FString& PlayerText)
{
    if (bBusy || PlayerText.IsEmpty()) return;
    bBusy = true;
    if (StateRoot.IsEmpty())
    {
        FetchGenesisThen([this, PlayerText]() { SendTurn(PlayerText); });
    }
    else
    {
        SendTurn(PlayerText);
    }
}

void UNheRelayComponent::FetchGenesisThen(TFunction<void()> Next)
{
    const FString Path = FString::Printf(TEXT("/v1/genesis?persona_id=%s&session_id=%s"),
        *FGenericPlatformHttp::UrlEncode(PersonaId), *FGenericPlatformHttp::UrlEncode(SessionId));
    TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Req = NewRequest(TEXT("GET"), Path);
    Req->OnProcessRequestComplete().BindWeakLambda(this, [this, Next](FHttpRequestPtr, FHttpResponsePtr Resp, bool bOk)
    {
        TSharedPtr<FJsonObject> J = (bOk && Resp.IsValid() && Resp->GetResponseCode() == 200) ? ParseObject(Resp->GetContentAsString()) : nullptr;
        FString Root;
        if (J.IsValid() && J->TryGetStringField(TEXT("state_root"), Root) && Root.Len() == 64)
        {
            StateRoot = Root;
            Next();
        }
        else
        {
            EmitFallback(FString(), TEXT("genesis_unavailable"));
        }
    });
    Req->ProcessRequest();
}

void UNheRelayComponent::SendTurn(const FString& PlayerText)
{
    TSharedPtr<FJsonObject> Body = MakeShared<FJsonObject>();
    Body->SetStringField(TEXT("persona_id"), PersonaId);
    Body->SetStringField(TEXT("session_id"), SessionId);
    Body->SetStringField(TEXT("player_text"), PlayerText.Left(280));
    Body->SetObjectField(TEXT("memory"), Memory);
    Body->SetStringField(TEXT("state_root"), StateRoot);
    if (!Receipt.IsEmpty()) Body->SetStringField(TEXT("receipt"), Receipt);
    if (!SceneJson.IsEmpty())
    {
        if (TSharedPtr<FJsonObject> Scene = ParseObject(SceneJson)) Body->SetObjectField(TEXT("scene"), Scene);
    }

    TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Req = NewRequest(TEXT("POST"), TEXT("/v1/turn"));
    Req->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
    Req->SetContentAsString(Serialize(Body));
    Req->OnProcessRequestComplete().BindWeakLambda(this, [this](FHttpRequestPtr, FHttpResponsePtr Resp, bool bOk)
    {
        HandleTurnResponse(Resp, bOk);
    });
    Req->ProcessRequest();
}

void UNheRelayComponent::HandleTurnResponse(FHttpResponsePtr Resp, bool bOk)
{
    TSharedPtr<FJsonObject> J = (bOk && Resp.IsValid()) ? ParseObject(Resp->GetContentAsString()) : nullptr;
    if (!J.IsValid())
    {
        EmitFallback(FString(), TEXT("network"));
        return;
    }
    bool bFallback = true;
    J->TryGetBoolField(TEXT("fallback"), bFallback);
    FString Text;
    J->TryGetStringField(TEXT("npc_text"), Text);
    if (bFallback)
    {
        FString Reason;
        J->TryGetStringField(TEXT("reason"), Reason);
        EmitFallback(Text, Reason); // the client state stays exactly as it was
        return;
    }

    // A checked reply: take the new state the relay issued.
    const TSharedPtr<FJsonObject>* NewMemory = nullptr;
    FString NewRoot, NewReceipt;
    if (!J->TryGetObjectField(TEXT("memory"), NewMemory) || !J->TryGetStringField(TEXT("state_root"), NewRoot) || !J->TryGetStringField(TEXT("receipt"), NewReceipt))
    {
        EmitFallback(FString(), TEXT("reply_shape"));
        return;
    }
    Memory = *NewMemory;
    StateRoot = NewRoot;
    Receipt = NewReceipt;
    bBusy = false;
    OnReply.Broadcast(Text, false, FString());

    const TSharedPtr<FJsonObject>* Tts = nullptr;
    if (bSpeakReplies && J->TryGetObjectField(TEXT("tts"), Tts))
    {
        FString Ticket;
        double Exp = 0;
        if ((*Tts)->TryGetStringField(TEXT("ticket"), Ticket) && (*Tts)->TryGetNumberField(TEXT("exp"), Exp))
        {
            FetchSpeech(Text, StateRoot, static_cast<int64>(Exp), Ticket);
        }
    }
}

void UNheRelayComponent::EmitFallback(const FString& RelayLine, const FString& Reason)
{
    bBusy = false;
    FString Line = RelayLine;
    if (Line.IsEmpty() && ScriptedLines.Num() > 0)
    {
        Line = ScriptedLines[NextScripted % ScriptedLines.Num()];
        ++NextScripted;
    }
    OnReply.Broadcast(Line, true, Reason);
}

// ---------------------------------------------------------------- speech out

void UNheRelayComponent::FetchSpeech(const FString& Text, const FString& Root, int64 Exp, const FString& Ticket)
{
    TSharedPtr<FJsonObject> Body = MakeShared<FJsonObject>();
    Body->SetStringField(TEXT("persona_id"), PersonaId);
    Body->SetStringField(TEXT("session_id"), SessionId);
    Body->SetStringField(TEXT("state_root"), Root);
    Body->SetStringField(TEXT("text"), Text);
    Body->SetNumberField(TEXT("exp"), static_cast<double>(Exp));
    Body->SetStringField(TEXT("ticket"), Ticket);

    TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Req = NewRequest(TEXT("POST"), TEXT("/v1/tts"));
    Req->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
    Req->SetContentAsString(Serialize(Body));
    Req->OnProcessRequestComplete().BindWeakLambda(this, [this](FHttpRequestPtr, FHttpResponsePtr Resp, bool bOk)
    {
        // A refusal comes back as JSON; only audio/wav is played. The text was already shown.
        if (bOk && Resp.IsValid() && Resp->GetResponseCode() == 200 && Resp->GetContentType().StartsWith(TEXT("audio/wav")))
        {
            PlayWav(Resp->GetContent());
        }
    });
    Req->ProcessRequest();
}

void UNheRelayComponent::PlayWav(const TArray<uint8>& Wav)
{
    // Walk the RIFF chunks for fmt and data; play 16-bit PCM only.
    if (Wav.Num() < 44 || FMemory::Memcmp(Wav.GetData(), "RIFF", 4) != 0 || FMemory::Memcmp(Wav.GetData() + 8, "WAVE", 4) != 0) return;
    int32 Channels = 0, Rate = 0, Bits = 0, DataOffset = -1, DataBytes = 0;
    int32 O = 12;
    while (O + 8 <= Wav.Num())
    {
        const int32 Size = LE32(Wav, O + 4);
        if (FMemory::Memcmp(Wav.GetData() + O, "fmt ", 4) == 0 && O + 24 <= Wav.Num())
        {
            Channels = LE16(Wav, O + 10);
            Rate = LE32(Wav, O + 12);
            Bits = LE16(Wav, O + 22);
        }
        else if (FMemory::Memcmp(Wav.GetData() + O, "data", 4) == 0)
        {
            DataOffset = O + 8;
            DataBytes = FMath::Min(Size, Wav.Num() - DataOffset);
            break;
        }
        O += 8 + Size + (Size & 1);
    }
    if (DataOffset < 0 || Bits != 16 || Channels < 1 || Rate <= 0) return;

    USoundWaveProcedural* Wave = NewObject<USoundWaveProcedural>(this);
    Wave->SetSampleRate(Rate);
    Wave->NumChannels = Channels;
    Wave->Duration = static_cast<float>(DataBytes) / (Rate * Channels * 2);
    Wave->SoundGroup = SOUNDGROUP_Voice;
    Wave->bLooping = false;
    Wave->QueueAudio(Wav.GetData() + DataOffset, DataBytes);

    if (Voice) Voice->Stop();
    Voice = UGameplayStatics::SpawnSoundAttached(Wave, GetOwner() ? GetOwner()->GetRootComponent() : nullptr);
}

// ---------------------------------------------------------------- speech in (push-to-talk)

void UNheRelayComponent::StartTalking()
{
    if (bCapturing) return;
    if (!Capture.IsValid()) Capture = MakeUnique<Audio::FAudioCapture>();

    Audio::FCaptureDeviceInfo Info;
    if (!Capture->GetCaptureDeviceInfo(Info)) return;
    {
        FScopeLock Lock(&CaptureLock);
        Captured.Reset();
        CaptureRate = Info.PreferredSampleRate;
    }

    Audio::FAudioCaptureDeviceParams Params; // default input device
    Audio::FOnAudioCaptureFunction OnCapture = [this](const void* InAudio, int32 NumFrames, int32 NumChannels, int32 SampleRate, double, bool)
    {
        // Audio thread: downmix to mono and keep at most MaxClipSeconds.
        const float* In = static_cast<const float*>(InAudio);
        FScopeLock Lock(&CaptureLock);
        CaptureRate = SampleRate;
        const int32 Max = FMath::RoundToInt(MaxClipSeconds * SampleRate);
        for (int32 F = 0; F < NumFrames && Captured.Num() < Max; ++F)
        {
            float Sum = 0.f;
            for (int32 C = 0; C < NumChannels; ++C) Sum += In[F * NumChannels + C];
            Captured.Add(Sum / FMath::Max(1, NumChannels));
        }
    };
    if (Capture->OpenAudioCaptureStream(Params, MoveTemp(OnCapture), 1024) && Capture->StartStream())
    {
        bCapturing = true;
    }
}

void UNheRelayComponent::StopTalking()
{
    if (!bCapturing || !Capture.IsValid()) return;
    Capture->StopStream();
    Capture->CloseStream();
    bCapturing = false;

    TArray<float> Clip;
    int32 Rate = 0;
    {
        FScopeLock Lock(&CaptureLock);
        Clip = MoveTemp(Captured);
        Rate = CaptureRate;
    }
    if (Clip.Num() < Rate / 4 || Rate <= 0) return; // under a quarter second: ignore
    SendClip(EncodeWav(Clip, Rate));
}

void UNheRelayComponent::SendClip(const TArray<uint8>& Wav)
{
    const FString Path = FString::Printf(TEXT("/v1/stt?session_id=%s"), *FGenericPlatformHttp::UrlEncode(SessionId));
    TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Req = NewRequest(TEXT("POST"), Path);
    Req->SetHeader(TEXT("Content-Type"), TEXT("audio/wav"));
    Req->SetContent(Wav);
    Req->OnProcessRequestComplete().BindWeakLambda(this, [this](FHttpRequestPtr, FHttpResponsePtr Resp, bool bOk)
    {
        TSharedPtr<FJsonObject> J = (bOk && Resp.IsValid()) ? ParseObject(Resp->GetContentAsString()) : nullptr;
        bool bFallback = true;
        FString Text;
        if (J.IsValid() && J->TryGetBoolField(TEXT("fallback"), bFallback) && !bFallback && J->TryGetStringField(TEXT("text"), Text) && !Text.IsEmpty())
        {
            OnHeard.Broadcast(Text);
            Say(Text);
        }
    });
    Req->ProcessRequest();
}
