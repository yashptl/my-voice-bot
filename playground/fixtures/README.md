# Test question files

Recorded questions for the voice spike. The playground lists every `*.wav` in this folder under
**Source**, and plays the chosen file through the same capture worklet as the mic (in real time,
then silence), so a turn can be repeated without speaking.

Format: WAV, PCM 16-bit little-endian, 16 kHz, mono. Any format the browser can decode works,
because the page resamples it, but these files match what Flux receives.

## Making one on macOS

```sh
say -v Samantha -o q1.aiff "Where does Yash work right now?" && afconvert -f WAVE -d LEI16@16000 -c 1 q1.aiff q1.wav
```

`say` writes speech with a system voice (`say -v '?'` lists them); `afconvert` converts it to
16-bit little-endian PCM at 16 kHz (`LEI16@16000`), mono (`-c 1`). Delete the `.aiff` afterwards.

## The files here

| File     | Question                                                       |
| -------- | -------------------------------------------------------------- |
| `q1.wav` | Where does Yash work right now?                                |
| `q2.wav` | Has Yash built anything with retrieval-augmented generation?   |
| `q3.wav` | Why should we hire Yash for an AI engineer role?               |

All three were made with the command above (voice Samantha). Check one with
`afinfo q1.wav` (expect `1 ch, 16000 Hz, Int16`).
