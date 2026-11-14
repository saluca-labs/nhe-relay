// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

#pragma once

#include "CoreMinimal.h"
#include "Components/ActorComponent.h"
#include "Interfaces/IHttpRequest.h"
#include "NheRelayComponent.generated.h"

class FJsonObject;
class UAudioComponent;
namespace Audio { class FAudioCapture; }

DECLARE_DYNAMIC_MULTICAST_DELEGATE_ThreeParams(FNheReplyEvent, const FString&, Text, bool, bFallback, const FString&, Reason);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FNheHeardEvent, const FString&, Text);

/**
 * Talks to one nhe-relay persona. Attach it to the character's actor.
 *
 * - Say(): one turn. The component keeps the client-held state (memory, state root, receipt)
 *   and only replaces it after a reply that is not a fallback.
 * - Any failure (network, timeout, a refusal from the relay) still produces a line: the
 *   persona's fallback line when the relay sent one, otherwise the next ScriptedLines entry.
 *   The game never waits on a model to keep going.
 * - StartTalking() / StopTalking(): push-to-talk. The clip is sent to /v1/stt and the text,
 *   when there is one, is sent on as a turn.
 * - With bSpeakReplies, each checked reply is fetched from /v1/tts and played. The relay voices
 *   only text it produced, so a reply is played only through its ticket. Playback expects WAV
 *   (16-bit PCM): set "format": "wav" on the TTS provider in relay.config.js.
 */
UCLASS(ClassGroup = (AI), meta = (BlueprintSpawnableComponent))
class NHERELAY_API UNheRelayComponent : public UActorComponent
{
    GENERATED_BODY()

public:
    UNheRelayComponent();

    /** Base URL of your relay, for example https://nhe-relay.example.workers.dev */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "NHE Relay")
    FString RelayUrl;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "NHE Relay")
    FString PersonaId = TEXT("museum-guide");

    /** 8 to 64 of A-Z a-z 0-9 _ -. Generated at BeginPlay when empty. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "NHE Relay")
    FString SessionId;

    /** Lines used, in order, when the relay cannot answer and sent no fallback line. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "NHE Relay")
    TArray<FString> ScriptedLines;

    /** Optional scene object sent with every turn, as JSON text (see examples/museum/scene.json). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "NHE Relay")
    FString SceneJson;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "NHE Relay")
    bool bSpeakReplies = true;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "NHE Relay")
    float TimeoutSeconds = 10.f;

    UPROPERTY(BlueprintAssignable, Category = "NHE Relay")
    FNheReplyEvent OnReply;

    UPROPERTY(BlueprintAssignable, Category = "NHE Relay")
    FNheHeardEvent OnHeard;

    UFUNCTION(BlueprintCallable, Category = "NHE Relay")
    void Say(const FString& PlayerText);

    UFUNCTION(BlueprintCallable, Category = "NHE Relay")
    void StartTalking();

    UFUNCTION(BlueprintCallable, Category = "NHE Relay")
    void StopTalking();

protected:
    virtual void BeginPlay() override;
    virtual void EndPlay(const EEndPlayReason::Type Reason) override;

private:
    void FetchGenesisThen(TFunction<void()> Next);
    void SendTurn(const FString& PlayerText);
    void HandleTurnResponse(FHttpResponsePtr Response, bool bOk);
    void FetchSpeech(const FString& Text, const FString& Root, int64 Exp, const FString& Ticket);
    void PlayWav(const TArray<uint8>& Wav);
    void SendClip(const TArray<uint8>& Wav);
    void EmitFallback(const FString& RelayLine, const FString& Reason);
    TSharedRef<IHttpRequest, ESPMode::ThreadSafe> NewRequest(const FString& Verb, const FString& Path) const;

    TSharedPtr<FJsonObject> Memory;
    FString StateRoot;
    FString Receipt;
    int32 NextScripted = 0;
    bool bBusy = false;

    TUniquePtr<Audio::FAudioCapture> Capture;
    FCriticalSection CaptureLock;
    TArray<float> Captured; // mono, at CaptureRate
    int32 CaptureRate = 0;
    bool bCapturing = false;

    UPROPERTY()
    TObjectPtr<UAudioComponent> Voice;
};
