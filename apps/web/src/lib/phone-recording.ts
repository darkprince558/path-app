export const MAX_DURATION_MS = 90_000;
export const MAX_VIDEO_BYTES = 240 * 1024 * 1024;

type MotionPermission = "granted" | "denied" | "unavailable";
type Axis3 = { x: number; y: number; z: number };
type Rotation = { alpha: number; beta: number; gamma: number };

export interface MotionSample {
  tMs: number;
  rotationRate: Rotation | null;
  acceleration: Axis3 | null;
  accelerationIncludingGravity: Axis3 | null;
}
export interface Take {
  id: string;
  video: Blob;
  motion: {
    version: 1;
    timebase: "recording-start-ms";
    durationMs: number;
    permission: MotionPermission;
    samples: MotionSample[];
  };
  endedReason: string;
}
export interface CaptureMeter {
  elapsed: number;
  gyro: number;
  accel: number;
  permission: MotionPermission;
}
export interface Recording {
  stream: MediaStream;
  stop: (reason?: string) => void;
  finished: Promise<Take>;
}

// Call in the tap handler. iOS consumes transient activation when prompting.
async function motionPermission(): Promise<MotionPermission> {
  const ctor = window.DeviceMotionEvent as
    | (typeof DeviceMotionEvent & { requestPermission?: () => Promise<PermissionState> })
    | undefined;
  if (!ctor) return "unavailable";
  if (!ctor.requestPermission) return "granted";
  try {
    return await ctor.requestPermission() === "granted" ? "granted" : "denied";
  } catch {
    return "denied";
  }
}
function axis3(value: DeviceMotionEventAcceleration | null): Axis3 | null {
  if (!value || ![value.x, value.y, value.z].every(Number.isFinite)) return null;
  return { x: value.x!, y: value.y!, z: value.z! };
}
function rotation(value: DeviceMotionEventRotationRate | null): Rotation | null {
  if (!value || ![value.alpha, value.beta, value.gamma].every(Number.isFinite)) return null;
  return { alpha: value.alpha!, beta: value.beta!, gamma: value.gamma! };
}

export async function startRecording(
  signal: AbortSignal, meter: (reading: CaptureMeter) => void,
): Promise<Recording> {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("Open the Mac’s HTTPS recorder link in Safari or Chrome to use the camera.");
  }
  if (!window.MediaRecorder) throw new Error("This browser cannot record video. Open the recorder in Safari or Chrome.");
  const permission = await motionPermission();
  signal.throwIfAborted();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
  });
  const release = () => stream.getTracks().forEach((track) => track.stop());
  try {
    signal.throwIfAborted();
    if (document.hidden) throw new Error("Bring the recorder back to the screen and start again.");
    const mimeType = ["video/mp4", "video/webm;codecs=vp8", "video/webm"].find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, { ...(mimeType && { mimeType }), videoBitsPerSecond: 6_000_000 });
    const id = crypto.randomUUID();
    const parts: Blob[] = [];
    const samples: MotionSample[] = [];
    let size = 0;
    let gyro = 0;
    let accel = 0;
    let elapsedAtStop: number | undefined;
    let reason = "";
    let failure = "";
    let start = 0;
    const stop = (why = "") => {
      if (elapsedAtStop !== undefined) return;
      elapsedAtStop = Math.max(1, Math.round(performance.now() - start));
      reason = why;
      if (recorder.state !== "inactive") recorder.stop();
    };
    const onMotion = (event: DeviceMotionEvent) => {
      if (elapsedAtStop !== undefined) return;
      // DOM event timestamps normally use performance.timeOrigin. Some WebKit
      // versions give an epoch timestamp. Keep events on the recording clock.
      const eventTime = event.timeStamp > 1e12 ? event.timeStamp - performance.timeOrigin : event.timeStamp;
      const now = performance.now();
      const validTime = Number.isFinite(eventTime) && eventTime > 0 && eventTime <= now + 10;
      const tMs = Math.round((validTime ? Math.min(eventTime, now) : now) - start);
      if (tMs < 0 || tMs < (samples.at(-1)?.tMs ?? 0) || tMs > MAX_DURATION_MS) return;
      const rotationRate = rotation(event.rotationRate);
      const acceleration = axis3(event.acceleration);
      const accelerationIncludingGravity = axis3(event.accelerationIncludingGravity);
      if (!rotationRate && !acceleration && !accelerationIncludingGravity) return;
      samples.push({ tMs, rotationRate, acceleration, accelerationIncludingGravity });
      if (rotationRate) gyro++;
      if (acceleration || accelerationIncludingGravity) accel++;
    };
    const onHidden = () => { if (document.hidden) stop("Recording stopped when the page went into the background."); };
    let muteTimeout = 0;
    let hasActiveVideo = false;
    const onCameraEnded = () => stop("The camera stopped. Review the captured portion before processing.");
    const onAborted = () => stop("Recording interrupted.");
    const track = stream.getVideoTracks()[0];
    const onUnmute = () => window.clearTimeout(muteTimeout);
    const onMute = () => {
      // WebKit can mute a newly opened camera before its first usable frame.
      // Take the first unmuted video chunk as evidence that media was flowing.
      if (!hasActiveVideo) return;
      onUnmute();
      muteTimeout = window.setTimeout(() => { if (track?.muted) onCameraEnded(); }, 1500);
    };
    recorder.ondataavailable = ({ data }) => {
      size += data.size;
      if (size > MAX_VIDEO_BYTES) {
        failure = "This take exceeded 240 MiB. Record a shorter walk.";
        stop();
      } else if (data.size) {
        parts.push(data);
        if (track && !track.muted) hasActiveVideo = true;
      }
    };
    // Use the instant we hand the first camera stream to MediaRecorder as
    // the time origin; encoded frames and DOM events have no shared hardware timestamp.
    start = performance.now();
    recorder.start(1000);
    if (permission === "granted") window.addEventListener("devicemotion", onMotion);
    track?.addEventListener("ended", onCameraEnded);
    track?.addEventListener("mute", onMute);
    track?.addEventListener("unmute", onUnmute);
    document.addEventListener("visibilitychange", onHidden);
    signal.addEventListener("abort", onAborted, { once: true });
    const tick = () => meter({ elapsed: performance.now() - start, gyro, accel, permission });
    const interval = window.setInterval(tick, 250);
    const limit = window.setTimeout(() => stop("Reached the 90-second recording limit."), MAX_DURATION_MS);
    const finished = new Promise<Take>((resolve, reject) => {
      recorder.onerror = () => {
        failure = "The browser interrupted video encoding. Start a new recording.";
        stop();
      };
      recorder.onstop = () => {
        window.clearInterval(interval);
        window.clearTimeout(limit);
        window.removeEventListener("devicemotion", onMotion);
        track?.removeEventListener("ended", onCameraEnded);
        onUnmute();
        track?.removeEventListener("mute", onMute);
        track?.removeEventListener("unmute", onUnmute);
        document.removeEventListener("visibilitychange", onHidden);
        signal.removeEventListener("abort", onAborted);
        release();
        const durationMs = Math.max(1, Math.min(MAX_DURATION_MS, elapsedAtStop ?? Math.round(performance.now() - start)));
        const video = new Blob(parts, { type: recorder.mimeType || parts[0]?.type || mimeType });
        if (failure || !video.size) {
          reject(new Error(failure || "No video frames were captured. Start a new recording."));
          return;
        }
        resolve({
          id, video, endedReason: reason,
          motion: { version: 1, timebase: "recording-start-ms", durationMs, permission, samples },
        });
      };
    });
    tick();
    return { stream, stop, finished };
  } catch (error) {
    release();
    throw error;
  }
}
