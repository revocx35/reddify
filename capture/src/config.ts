/** Runtime configuration of the capture container, read once from the environment (see docker-compose.yml). */
export interface CaptureConfig {
  host: string;
  port: number;
  /** Shared with the app and the chromium manager; the bearer token is derived from it. */
  controlSecret: Buffer;
  chromeBin: string;
  chromeProfile: string;
  /** Scratch space for recordings (a tmpfs: the app copies each finished file into its library). */
  workDir: string;
  display: number;
  width: number;
  height: number;
  timeZone: string;
  /** PulseAudio server socket (the container's own daemon). */
  pulseServer: string;
  /** The virtual speaker whose monitor is recorded. */
  sinkName: string;
  parec: string;
  ffmpeg: string;
  ffprobe: string;
  rate: number;
  channels: number;
  /** Recordings queued while one is running (Spotify plays one stream per account). */
  maxQueue: number;
  /** Stop the engine's Chrome after this many idle minutes (0 = keep it running). */
  idleStopMinutes: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CaptureConfig {
  const secret = env.CONTROL_SECRET ?? '';
  if (secret.length < 32) throw new Error('CONTROL_SECRET must be set (at least 32 characters).');
  const screen = /^(\d{3,4})x(\d{3,4})x(16|24)$/.exec(env.SCREEN ?? '1280x800x24');
  if (!screen) throw new Error(`invalid SCREEN ${env.SCREEN} (expected e.g. 1280x800x24)`);
  return {
    host: env.LISTEN_ADDR ?? '0.0.0.0',
    port: Number(env.PORT ?? 9224),
    controlSecret: Buffer.from(secret, 'utf8'),
    chromeBin: env.CHROME_BIN ?? '/usr/bin/google-chrome-stable',
    chromeProfile: env.CHROME_PROFILE ?? '/data/profile',
    workDir: env.WORK_DIR ?? '/run/capture',
    display: Number(env.DISPLAY_NUM ?? 99),
    width: Number(screen[1]),
    height: Number(screen[2]),
    timeZone: env.TZ ?? 'UTC',
    pulseServer: env.PULSE_SERVER ?? 'unix:/run/pulse/native',
    sinkName: env.SINK_NAME ?? 'reddify',
    parec: env.PAREC_BIN ?? 'parec',
    ffmpeg: env.FFMPEG_BIN ?? 'ffmpeg',
    ffprobe: env.FFPROBE_BIN ?? 'ffprobe',
    rate: Number(env.RATE ?? 44100),
    channels: Number(env.CHANNELS ?? 2),
    maxQueue: Number(env.MAX_QUEUE ?? 4),
    idleStopMinutes: Number(env.IDLE_STOP_MINUTES ?? 0),
  };
}
