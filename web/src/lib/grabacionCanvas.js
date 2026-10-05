// Canvas 1280x720 que compone el frame del VIDEO A GUARDAR: cámara + la letra
// que se está cantando + una marca de agua. Es aparte del canvas en pantalla
// (que tiene el esqueleto, guías, etc.).
//
//   dibujar()      -> pinta un frame (llamalo en el rAF mientras grabás)
//   stream(fps)    -> MediaStream de video (canvas.captureStream)

const W = 1280;
const H = 720;

export function crearGrabacionCanvas(video, { getLetra, titulo }) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });

  function dibujar() {
    ctx.fillStyle = '#0a0716';
    ctx.fillRect(0, 0, W, H);

    // --- cámara (cover-fit, espejada) ---
    if (video.videoWidth) {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const s = Math.max(W / vw, H / vh);
      const dw = vw * s;
      const dh = vh * s;
      ctx.save();
      ctx.translate(W, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(video, (W - dw) / 2, (H - dh) / 2, dw, dh);
      ctx.restore();
    }

    // --- banda inferior para la letra ---
    const bandaH = H * 0.34;
    const grad = ctx.createLinearGradient(0, H - bandaH, 0, H);
    grad.addColorStop(0, 'rgba(10,7,22,0)');
    grad.addColorStop(0.4, 'rgba(10,7,22,0.55)');
    grad.addColorStop(1, 'rgba(10,7,22,0.85)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, H - bandaH, W, bandaH);

    // --- letra actual (palabras cantadas en rosa) ---
    const l = getLetra?.();
    if (l && l.texto) {
      // se dibuja en MAYUSCULAS: tambien hay que medir en mayusculas (antes se media en
      // minusculas y las palabras salian encimadas)
      const palabras = l.texto.toUpperCase().split(/\s+/).filter(Boolean);
      let size = 58;
      ctx.textBaseline = 'alphabetic';
      // achicar hasta que entre en 2 líneas
      let lineas;
      do {
        ctx.font = `900 ${size}px "Archivo Black", Arial, sans-serif`;
        lineas = envolver(ctx, palabras, W * 0.88);
        size -= 4;
      } while (lineas.length > 2 && size > 22);

      const lh = size * 1.15;
      let y = H - bandaH / 2 - ((lineas.length - 1) * lh) / 2 + size * 0.35;
      let idx = 0;
      for (const linea of lineas) {
        const ancho = linea.reduce((w, p) => w + ctx.measureText(p + ' ').width, 0);
        let x = (W - ancho) / 2;
        for (const p of linea) {
          ctx.fillStyle = idx < (l.hechas || 0) ? '#ec2f80' : '#ffffff';
          ctx.fillText(p, x, y);
          x += ctx.measureText(p + ' ').width;
          idx++;
        }
        y += lh;
      }
    }

    // --- marca de agua ---
    ctx.font = '600 22px "Archivo", Arial, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.textAlign = 'left';
    ctx.fillText('karaoke.studio', 28, 40);
    if (titulo) {
      ctx.textAlign = 'right';
      ctx.fillText(titulo, W - 28, 40);
    }
    ctx.textAlign = 'left';
  }

  function stream(fps = 30) {
    return canvas.captureStream(fps);
  }

  return { dibujar, stream, canvas };
}

function envolver(ctx, palabras, maxAncho) {
  const lineas = [];
  let actual = [];
  let ancho = 0;
  for (const p of palabras) {
    const w = ctx.measureText(p + ' ').width;
    if (ancho + w > maxAncho && actual.length) {
      lineas.push(actual);
      actual = [];
      ancho = 0;
    }
    actual.push(p);
    ancho += w;
  }
  if (actual.length) lineas.push(actual);
  return lineas;
}
