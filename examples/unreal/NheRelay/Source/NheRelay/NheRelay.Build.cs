// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Saluca Labs

using UnrealBuildTool;

public class NheRelay : ModuleRules
{
    public NheRelay(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

        PublicDependencyModuleNames.AddRange(new string[]
        {
            "Core",
            "CoreUObject",
            "Engine",
        });

        PrivateDependencyModuleNames.AddRange(new string[]
        {
            "HTTP",
            "Json",
            "AudioCaptureCore",
            "AudioMixer",
        });
    }
}
