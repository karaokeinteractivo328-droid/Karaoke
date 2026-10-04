// Cámara + esqueleto de manos + guías de gesto, TODO en un canvas y con la
// misma matemática -> la mano real y el dibujo siempre coinciden.

const CONEXIONES = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];

export function crearCamara(canvas, video) {
  const ctx = canvas.getContext('2d');
  let W = innerWidth;
  let H = innerHeight;

  function ajustar() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    W = innerWidth;
    H = innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  ajustar();
  addEventListener('resize', ajustar);

  // geometría cover-fit (idéntica para el video y el esqueleto)
  function geo() {
    const vw = video.videoWidth || 1280;
    const vh = video.videoHeight || 720;
    const s = Math.max(W / vw, H / vh);
    const dw = vw * s;
    const dh = vh * s;
    return { dw, dh, ox: (W - dw) / 2, oy: (H - dh) / 2 };
  }
  // punto normalizado (0..1, ya espejado) -> pantalla
  function aPantalla(nx, ny, g) {
    return [g.ox + nx * g.dw, g.oy + ny * g.dh];
  }

  function dibujar(datos) {
    ctx.clearRect(0, 0, W, H);
    if (!video.videoWidth) return;
    const g = geo();

    // --- cámara (espejada) ---
    ctx.save();
    ctx.translate(W, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, g.ox, g.oy, g.dw, g.dh);
    ctx.restore();

    // --- esqueleto ---
    const manos = datos?.manos || [];
    if (!manos.length) return;
    const gr = Math.max(3, Math.min(W, H) * 0.006);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const mano of manos) {
      const pts = mano.puntos.map((p) => aPantalla(p.x, p.y, g));
      // contorno oscuro + línea clara -> se ve sobre cualquier fondo
      trazo(pts, gr * 2.1, 'rgba(0,0,0,0.55)');
      trazo(pts, gr, datos.pellizco ? '#ffcf40' : '#ffffff');
      ctx.fillStyle = '#ec2f80';
      for (const [x, y] of pts) {
        ctx.beginPath();
        ctx.arc(x, y, gr * 1.1, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (datos.pinchProgress > 0) {
      const p = manos[0].puntos;
      const a = aPantalla(p[4].x, p[4].y, g);
      const b = aPantalla(p[8].x, p[8].y, g);
      ctx.strokeStyle = '#ec2f80';
      ctx.lineWidth = gr * 1.6;
      ctx.beginPath();
      ctx.arc((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.min(W, H) * 0.05,
        -Math.PI / 2, -Math.PI / 2 + datos.pinchProgress * Math.PI * 2);
      ctx.stroke();
    }

    function trazo(pts, w, color) {
      ctx.strokeStyle = color;
      ctx.lineWidth = w;
      ctx.beginPath();
      for (const [i, j] of CONEXIONES) {
        ctx.moveTo(pts[i][0], pts[i][1]);
        ctx.lineTo(pts[j][0], pts[j][1]);
      }
      ctx.stroke();
    }
  }

  return { dibujar };
}
