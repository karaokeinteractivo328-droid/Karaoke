// Fondo "poster": estrella magenta que gira despacio detras del cantante, con
// una copia negra corrida (efecto sticker). Late sutilmente con la musica.
// Nada de luces ni glow.

export function crearEscenario(contenedor) {
  const NS = 'http://www.w3.org/2000/svg';
  const puntas = 14;
  const rExt = 100;
  const rInt = 42;

  let d = '';
  for (let i = 0; i < puntas * 2; i++) {
    const r = i % 2 === 0 ? rExt : rInt;
    const jitter = i % 2 === 0 ? 1 + (i % 3) * 0.04 : 1;
    const ang = (i / (puntas * 2)) * Math.PI * 2 - Math.PI / 2;
    const x = 120 + Math.cos(ang) * r * jitter;
    const y = 120 + Math.sin(ang) * r * jitter;
    d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
  }
  d += 'Z';

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 240 240');
  svg.classList.add('estrella');

  const sombra = document.createElementNS(NS, 'path');
  sombra.setAttribute('d', d);
  sombra.setAttribute('transform', 'translate(6 8)');
  sombra.setAttribute('fill', '#141414');

  const forma = document.createElementNS(NS, 'path');
  forma.setAttribute('d', d);
  forma.setAttribute('fill', 'var(--rosa)');

  svg.append(sombra, forma);
  contenedor.appendChild(svg);

  // El latido solo se actualiza si el cambio se NOTA (>0,4 %) y a lo sumo 20 veces por segundo: antes se
  // escribia una variable CSS en cada cuadro (60/s) y eso obligaba al navegador a recalcular estilos todo el tiempo.
  let ultimoPulso = -1;
  let ultimoT = 0;
  return {
    latir(energia = 0) {
      const pulso = 1 + energia * 0.14;
      const t = performance.now();
      if (Math.abs(pulso - ultimoPulso) < 0.004 || t - ultimoT < 50) return;
      ultimoPulso = pulso;
      ultimoT = t;
      svg.style.setProperty('--pulso', pulso.toFixed(3));
    },
    setModo(modo) {
      contenedor.dataset.modo = modo || '';
    },
  };
}
