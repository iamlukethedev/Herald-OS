import type { KeySound } from './keys.ts'

/*
 * Soft key ticks synthesized with Web Audio, no audio files: a short burst of filtered noise for digits, a
 * lower one with a little body for operators, and two quiet sine partials for equals. The context
 * is made on the first key press, as browsers only let a gesture start audio.
 */

let context: AudioContext | null = null
let noise: AudioBuffer | null = null

function audio(): AudioContext {
  if (!context || context.state === 'closed') {
    context = new AudioContext()
    noise = null
  }

  if (context.state === 'suspended') {
    void context.resume()
  }

  return context
}

function noiseBuffer(output: AudioContext): AudioBuffer {
  if (!noise) {
    noise = output.createBuffer(1, Math.ceil(output.sampleRate * 0.08), output.sampleRate)
    const samples = noise.getChannelData(0)

    for (let index = 0; index < samples.length; index++) {
      samples[index] = Math.random() * 2 - 1
    }
  }

  return noise
}

/** A gain that rises in 2 ms and fades out over `seconds`. */
function envelope(output: AudioContext, peak: number, seconds: number): GainNode {
  const gain = output.createGain()
  const now = output.currentTime
  gain.gain.setValueAtTime(0, now)
  gain.gain.linearRampToValueAtTime(peak, now + 0.002)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + seconds)
  gain.connect(output.destination)

  return gain
}

function tick(output: AudioContext, frequency: number, peak: number, seconds: number): void {
  const source = output.createBufferSource()
  const filter = output.createBiquadFilter()
  source.buffer = noiseBuffer(output)
  filter.type = 'bandpass'
  filter.frequency.value = frequency
  filter.Q.value = 1.4
  source.connect(filter)
  filter.connect(envelope(output, peak, seconds))
  source.start()
  source.stop(output.currentTime + seconds + 0.01)
}

function tone(output: AudioContext, frequency: number, peak: number, seconds: number, delay = 0): void {
  const oscillator = output.createOscillator()
  const gain = output.createGain()
  const start = output.currentTime + delay
  oscillator.type = 'sine'
  oscillator.frequency.value = frequency
  gain.gain.setValueAtTime(0, start)
  gain.gain.linearRampToValueAtTime(peak, start + 0.004)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + seconds)
  oscillator.connect(gain)
  gain.connect(output.destination)
  oscillator.start(start)
  oscillator.stop(start + seconds + 0.02)
}

export function playKeySound(sound: KeySound): void {
  try {
    const output = audio()

    if (sound === 'digit') {
      tick(output, 3400, 0.05, 0.028)
    } else if (sound === 'operator') {
      tick(output, 1900, 0.05, 0.04)
      tone(output, 420, 0.018, 0.05)
    } else {
      tone(output, 660, 0.03, 0.12)
      tone(output, 990, 0.02, 0.16, 0.035)
    }
  } catch {
    // Sounds are a nicety: without audio output the keypad stays quiet.
  }
}
