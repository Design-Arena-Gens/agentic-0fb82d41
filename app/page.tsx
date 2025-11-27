 "use client";
import ThemeToggle from "../components/ThemeToggle";
import { useEffect, useMemo, useRef, useState } from "react";

type VoiceOption = {
  name: string;
  lang: string;
  voiceURI: string;
  default: boolean;
};

type JobState = {
  text: string;
  voiceURI?: string;
  rate: number;
  pitch: number;
  volume: number;
  mp3Url?: string;
  mp4Url?: string;
  imageUrl?: string;
  durationMs?: number;
  status: "idle" | "capturing" | "encoding" | "ready" | "error";
  error?: string;
  progress?: number;
};

export default function Page() {
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [state, setState] = useState<JobState>({
    text: "",
    rate: 1,
    pitch: 1,
    volume: 1,
    status: "idle",
  });
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const [isBusy, setIsBusy] = useState(false);

  useEffect(() => {
    const loadVoices = () => {
      const list = window.speechSynthesis.getVoices() || [];
      const mapped = list.map((v) => ({
        name: v.name,
        lang: v.lang,
        voiceURI: v.voiceURI,
        default: v.default,
      }));
      setVoices(mapped);
      if (!state.voiceURI && mapped.length) {
        const pt = mapped.find((v) => v.lang.toLowerCase().startsWith("pt"));
        setState((s) => ({ ...s, voiceURI: (pt ?? mapped[0]).voiceURI }));
      }
    };
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
  }, [state.voiceURI]);

  const selectedVoice = useMemo(
    () => voices.find((v) => v.voiceURI === state.voiceURI),
    [voices, state.voiceURI]
  );

  async function speakAndRecord(text: string) {
    setIsBusy(true);
    setState((s) => ({ ...s, status: "capturing", error: undefined, progress: 0, mp3Url: undefined, mp4Url: undefined }));
    try {
      // Request tab/system audio capture (user will be prompted)
      // Some browsers require video:true to capture system audio; we'll hide track later.
      const stream = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: true,
      });
      // Mute the video track to avoid echo; stop it soon after start.
      const [videoTrack] = stream.getVideoTracks();
      setTimeout(() => videoTrack.stop(), 1500);

      const rec = new MediaRecorder(stream, { mimeType: "audio/webm" });
      recRef.current = rec;
      chunksRef.current = [];
      const startedAt = Date.now();
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      const stopped = new Promise<void>((resolve) => (rec.onstop = () => resolve()));
      rec.start(250);

      await speakText(text);
      rec.stop();
      await stopped;
      const webmBlob = new Blob(chunksRef.current, { type: "audio/webm" });
      const durationMs = Date.now() - startedAt;
      const mp3Blob = await transcodeWebmToMp3(webmBlob, (p) =>
        setState((s) => ({ ...s, status: "encoding", progress: p }))
      );
      const mp3Url = URL.createObjectURL(mp3Blob);
      setState((s) => ({ ...s, mp3Url, durationMs }));
      return { mp3Blob, durationMs };
    } catch (err: any) {
      console.error(err);
      setState((s) => ({ ...s, status: "error", error: err?.message ?? String(err) }));
      throw err;
    } finally {
      setIsBusy(false);
    }
  }

  function speakText(text: string) {
    return new Promise<void>((resolve, reject) => {
      const synth = window.speechSynthesis;
      if (synth.speaking) synth.cancel();
      const chunks = splitText(text, 1800);
      let index = 0;
      const onEnd = () => {
        index += 1;
        setState((s) => ({ ...s, progress: Math.round((index / chunks.length) * 25) })); // 0-25% during TTS
        if (index < chunks.length) {
          speakChunk(chunks[index], onEnd, reject);
        } else {
          resolve();
        }
      };
      speakChunk(chunks[index], onEnd, reject);
    });
  }

  function speakChunk(chunk: string, onEnd: () => void, onError: (e: any) => void) {
    const u = new SpeechSynthesisUtterance(chunk);
    if (selectedVoice) {
      const voice = window.speechSynthesis.getVoices().find(v => v.voiceURI === selectedVoice.voiceURI);
      if (voice) u.voice = voice;
    }
    u.rate = state.rate;
    u.pitch = state.pitch;
    u.volume = state.volume;
    u.onerror = (e) => onError(e.error ?? e);
    u.onend = onEnd;
    window.speechSynthesis.speak(u);
  }

  function splitText(input: string, maxLen: number) {
    const parts: string[] = [];
    let remaining = input.trim();
    const sentenceRe = /([.!??]+|\n+)/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = sentenceRe.exec(remaining)) !== null) {
      const end = match.index + match[0].length;
      const segment = remaining.slice(lastIndex, end).trim();
      if (segment) parts.push(segment);
      lastIndex = end;
    }
    const tail = remaining.slice(lastIndex).trim();
    if (tail) parts.push(tail);
    // Merge small parts to respect maxLen
    const merged: string[] = [];
    let buf = "";
    for (const p of parts) {
      if ((buf + " " + p).trim().length <= maxLen) {
        buf = (buf ? buf + " " : "") + p;
      } else {
        if (buf) merged.push(buf);
        buf = p;
      }
    }
    if (buf) merged.push(buf);
    return merged.length ? merged : [remaining];
  }

  async function transcodeWebmToMp3(webm: Blob, onProgress?: (p: number) => void): Promise<Blob> {
    const { FFmpeg } = await import("@ffmpeg/ffmpeg");
    const { fetchFile } = await import("@ffmpeg/util");
    const ffmpeg = new FFmpeg();
    await ffmpeg.load();
    await ffmpeg.writeFile("in.webm", await fetchFile(webm));
    await ffmpeg.exec([
      "-i", "in.webm",
      "-vn",
      "-acodec", "libmp3lame",
      "-b:a", "192k",
      "out.mp3",
    ]);
    const data = await ffmpeg.readFile("out.mp3");
    const blob = new Blob([data as Uint8Array], { type: "audio/mpeg" });
    onProgress?.(100);
    return blob;
  }

  async function generateImageFromText(text: string, width = 1920, height = 1080) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    // Background gradient
    const grad = ctx.createLinearGradient(0, 0, width, height);
    grad.addColorStop(0, "#111827");
    grad.addColorStop(1, "#4f46e5");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);
    // Title
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 64px Inter, system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const padding = 80;
    ctx.fillText("TextToVideo Converter Pro", padding, padding);
    // Body text
    ctx.font = "28px Inter, system-ui, sans-serif";
    const boxWidth = width - padding * 2;
    const lines = wrapText(ctx, text.slice(0, 800), boxWidth);
    let y = padding + 100;
    for (const line of lines.slice(0, 14)) {
      ctx.fillText(line, padding, y);
      y += 40;
    }
    // Footer
    ctx.font = "24px Inter, system-ui, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillText("Gerado automaticamente a partir de texto", padding, height - padding - 32);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png", 0.95));
    if (!blob) throw new Error("Falha ao gerar imagem");
    return { blob, url: URL.createObjectURL(blob) };
  }

  function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
    const words = text.replace(/\s+/g, " ").trim().split(" ");
    const lines: string[] = [];
    let line = "";
    for (const w of words) {
      const test = (line ? line + " " : "") + w;
      if (ctx.measureText(test).width > maxWidth) {
        if (line) lines.push(line);
        line = w;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  async function composeVideo(mp3Blob: Blob, imageBlob: Blob, onProgress?: (p: number) => void) {
    setState((s) => ({ ...s, status: "encoding", progress: 40 }));
    const { FFmpeg } = await import("@ffmpeg/ffmpeg");
    const { fetchFile } = await import("@ffmpeg/util");
    const ffmpeg = new FFmpeg();
    await ffmpeg.load();
    await ffmpeg.writeFile("bg.png", await fetchFile(imageBlob));
    await ffmpeg.writeFile("audio.mp3", await fetchFile(mp3Blob));
    // Probe audio duration to estimate progress
    await ffmpeg.exec(["-i", "audio.mp3", "-f", "null", "-"]);
    // Build video from static image + audio
    await ffmpeg.exec([
      "-loop", "1",
      "-i", "bg.png",
      "-i", "audio.mp3",
      "-c:v", "libx264",
      "-tune", "stillimage",
      "-c:a", "aac",
      "-b:a", "192k",
      "-pix_fmt", "yuv420p",
      "-shortest",
      "-movflags", "+faststart",
      "-vf", "fps=30,scale=1920:1080:flags=lanczos",
      "out.mp4"
    ]);
    const mp4 = await ffmpeg.readFile("out.mp4");
    const blob = new Blob([mp4 as Uint8Array], { type: "video/mp4" });
    onProgress?.(100);
    return blob;
  }

  async function handleGenerate() {
    const text = state.text.trim();
    if (!text) return;
    if (text.length > 200_000) {
      setState((s) => ({ ...s, error: "O texto excede 200.000 caracteres." }));
      return;
    }
    try {
      const { mp3Blob, durationMs } = await speakAndRecord(text);
      setState((s) => ({ ...s, status: "encoding", progress: 55 }));
      const { blob: imageBlob, url: imageUrl } = await generateImageFromText(text);
      setState((s) => ({ ...s, imageUrl, progress: 65 }));
      const mp4Blob = await composeVideo(mp3Blob, imageBlob, (p) =>
        setState((s) => ({ ...s, progress: Math.max(70, p) }))
      );
      const mp4Url = URL.createObjectURL(mp4Blob);
      setState((s) => ({ ...s, status: "ready", progress: 100, mp4Url, durationMs }));
    } catch (e) {
      // state handled in inner functions
    }
  }

  return (
    <main className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-gray-200 dark:border-gray-800 backdrop-blur bg-white/70 dark:bg-gray-900/70">
        <div className="mx-auto max-w-6xl px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-xl font-bold">TextToVideo Converter Pro</span>
            <span className="text-xs rounded bg-brand-600/10 text-brand-700 dark:text-brand-300 px-2 py-0.5">beta</span>
          </div>
          <ThemeToggle />
        </div>
      </header>
      <div className="mx-auto max-w-6xl px-4 py-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="card p-4">
          <h2 className="text-lg font-semibold mb-3">Entrada de Texto</h2>
          <textarea
            className="input h-64 resize-y"
            placeholder="Cole ou digite o texto (at? 200.000 caracteres)..."
            maxLength={200_000}
            value={state.text}
            onChange={(e) => setState((s) => ({ ...s, text: e.target.value }))}
          />
          <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label className="text-sm block mb-1">Voz</label>
              <select
                className="input"
                value={state.voiceURI}
                onChange={(e) => setState((s) => ({ ...s, voiceURI: e.target.value }))}
              >
                {voices.map((v) => (
                  <option key={v.voiceURI} value={v.voiceURI}>
                    {v.name} ({v.lang})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-sm block mb-1">Velocidade</label>
              <input
                className="input"
                type="number"
                step="0.1"
                min="0.5"
                max="2"
                value={state.rate}
                onChange={(e) => setState((s) => ({ ...s, rate: Number(e.target.value) }))}
              />
            </div>
            <div>
              <label className="text-sm block mb-1">Tom</label>
              <input
                className="input"
                type="number"
                step="0.1"
                min="0"
                max="2"
                value={state.pitch}
                onChange={(e) => setState((s) => ({ ...s, pitch: Number(e.target.value) }))}
              />
            </div>
            <div>
              <label className="text-sm block mb-1">Volume</label>
              <input
                className="input"
                type="number"
                step="0.1"
                min="0"
                max="1"
                value={state.volume}
                onChange={(e) => setState((s) => ({ ...s, volume: Number(e.target.value) }))}
              />
            </div>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <button
              className="btn btn-primary disabled:opacity-50"
              onClick={handleGenerate}
              disabled={isBusy || !state.text.trim()}
            >
              {isBusy ? "Processando..." : "Gerar MP3 e MP4"}
            </button>
            {state.status !== "idle" && (
              <div className="text-sm opacity-80">
                Status: {state.status} {typeof state.progress === "number" ? `? ${state.progress}%` : ""}
              </div>
            )}
          </div>
          {state.error && <p className="mt-3 text-sm text-red-600">{state.error}</p>}
          <p className="mt-3 text-xs opacity-70">
            Dica: o navegador solicitar? permiss?o para capturar o ?udio da aba. O ?udio sintetizado ser? gravado e convertido para MP3 localmente.
          </p>
        </section>

        <section className="card p-4">
          <h2 className="text-lg font-semibold mb-3">Pr?-visualiza??o e Exporta??o</h2>
          <div className="grid gap-3">
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="flex-1">
                <label className="text-sm block mb-1">?udio MP3</label>
                {state.mp3Url ? (
                  <audio controls src={state.mp3Url} className="w-full" />
                ) : (
                  <div className="text-sm opacity-70">Ainda n?o gerado.</div>
                )}
                {state.mp3Url && (
                  <a className="btn btn-outline mt-2" href={state.mp3Url} download="audio.mp3">Baixar MP3</a>
                )}
              </div>
            </div>
            <div>
              <label className="text-sm block mb-1">Imagem de Fundo</label>
              {state.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={state.imageUrl} alt="Pr?via" className="rounded-lg border border-gray-200 dark:border-gray-800 max-h-60 object-cover" />
              ) : (
                <div className="text-sm opacity-70">Ser? gerada automaticamente a partir do texto.</div>
              )}
            </div>
            <div>
              <label className="text-sm block mb-1">V?deo MP4</label>
              {state.mp4Url ? (
                <video controls className="w-full rounded-lg border border-gray-200 dark:border-gray-800">
                  <source src={state.mp4Url} type="video/mp4" />
                </video>
              ) : (
                <div className="text-sm opacity-70">Ainda n?o gerado.</div>
              )}
              {state.mp4Url && (
                <a className="btn btn-outline mt-2" href={state.mp4Url} download="video.mp4">Baixar MP4</a>
              )}
              {state.durationMs && (
                <div className="mt-2 text-xs opacity-70">
                  Dura??o aproximada: {(state.durationMs / 1000).toFixed(1)}s
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
      <footer className="py-6 text-center text-sm opacity-70">
        ? {new Date().getFullYear()} TextToVideo Converter Pro ? Tudo processado localmente no seu navegador
      </footer>
    </main>
  );
}

