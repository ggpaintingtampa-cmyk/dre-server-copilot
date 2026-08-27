# Ollama Runtime

Source checkpoint for the optional local Ollama runtime.

- Tested Ollama runtime version: `0.33.1`
- Bind address: `127.0.0.1:11434` (loopback only; do not expose publicly)
- Model directory: `OLLAMA_MODELS=/workspace/models/ollama`
- No model weights belong in the image or this repository.
- `/workspace` may be disposable unless a persistent RunPod volume is mounted.
- Local model availability must never be required for Copilot/OpenAI startup. Copilot and its OpenAI path must remain healthy when Ollama has no local models or is unavailable.

`start-ollama.sh` creates the model directory, sets the runtime environment, and starts `ollama serve`. It does not download models or contain credentials.
