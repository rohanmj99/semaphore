import { useEffect, useRef } from "react";
import { LightTransport } from "@core/qr/light";
import { encodeJab, paintJab } from "@core/qr/jab";

/** Paints the current JAB frame of a light transport and animates it at the
 *  channel's frame pace. Callers must pass a live transport (the controller's
 *  display or the receiver's match display). `frameMs` overrides the
 *  transport's pace (used by the sender's frame-rate slider). */
export function QrCard({
  transport,
  maxSize = 460,
  frameMs,
}: {
  transport: LightTransport | null;
  maxSize?: number;
  frameMs?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!transport) return;
    const pace = frameMs ?? transport.frameMs;
    let timer: ReturnType<typeof setInterval> | null = null;
    const paint = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const frag = transport.currentFrag();
      if (!frag) {
        canvas.width = 4;
        canvas.height = 4;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, 4, 4);
        return;
      }
      const matrix = encodeJab(frag);
      const avail = Math.min(canvas.parentElement?.clientWidth ?? maxSize, maxSize);
      const scale = Math.max(2, Math.min(10, Math.floor(avail / (matrix.size + 8))));
      const img = paintJab(matrix, scale, 4);
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.putImageData(new ImageData(img.rgba, img.width, img.height), 0, 0);
      transport.advance();
    };
    paint();
    timer = setInterval(paint, pace);
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [transport, maxSize, frameMs]);

  return (
    <div className="qrcard-frame">
      <canvas ref={canvasRef} className="qrcard" role="img" aria-label="Animated JAB code" />
      <span className="qrcard-mark">SEMA·PHORE</span>
    </div>
  );
}
