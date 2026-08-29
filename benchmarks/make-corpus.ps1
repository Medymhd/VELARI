# Real-speech STT corpus via Windows SAPI TTS (free, offline).
# Generates 16 kHz / 16-bit / mono WAVs of interview questions into benchmarks/corpus/.
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
    16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)

$questions = @(
    "Tell me about a time you had to influence a stakeholder without authority.",
    "Walk me through how you prioritize when everything is urgent.",
    "Describe the most complex system you have designed end to end.",
    "How do you handle disagreeing with your manager's decision?",
    "What would you consider your biggest professional failure so far?",
    "Describe a situation where you had to deliver bad news to your team."
)

New-Item -ItemType Directory -Force "benchmarks\corpus" | Out-Null
$dir = (Resolve-Path "benchmarks\corpus").Path
for ($i = 0; $i -lt $questions.Count; $i++) {
    $path = Join-Path $dir ("q" + ($i + 1) + ".wav")
    $synth.SetOutputToWaveFile($path, $fmt)
    $synth.Speak($questions[$i])
    Write-Host "wrote $path"
}
$synth.Dispose()
