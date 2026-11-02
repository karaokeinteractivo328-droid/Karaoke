// DETECCION de la camara con MediaPipe Tasks Vision (Google). Solo detecta:
//   - HandLandmarker : landmarks de las manos (crudos, sin identidad)
//   - FaceDetector   : "hay una persona" + donde esta la cara (referencia de
//                      "mano arriba": por encima del mentón)
// La identidad, el suavizado y la estabilidad viven en seguimiento.js (TRACKING)
// y la interpretacion en manos.js (GESTOS). Aca no se decide nada de eso.
//
// Assets desde /mediapipe/wasm, /models (web/scripts/preparar-mediapipe.mjs).

import { FilesetResolver, HandLandmarker, FaceDetector } from '@mediapipe/tasks-vision';

const WASM = '/mediapipe/wasm';
const MODELO_MANOS = '/models/hand_landmarker.task';
const MODELO_CARA = '/models/blaze_face_short_range.tflite';

export async function crearReconocimiento({ video, numManos = 2, onResultado }) {
  const fileset = await FilesetResolver.forVisionTasks(WASM);

  const handLandmarker = await crearCon(HandLandmarker, fileset, {
    baseOptions: { modelAssetPath: MODELO_MANOS },
    runningMode: 'VIDEO',
    numHands: numManos,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });

  let faceDetector = null;
  try {
    faceDetector = await crearCon(FaceDetector, fileset, {
      baseOptions: { modelAssetPath: MODELO_CARA },
      runningMode: 'VIDEO',
      minDetectionConfidence: 0.4,
    });
  } catch (err) {
    console.warn('[vision] FaceDetector no disponible:', err.message);
  }

  await esperarVideo(video);

  let ultimoT = -1;
  let corriendo = true;
  let hayPersona = false;
  let cara = null; // { cx, cy, w, h } normalizada y espejada
  let caraVistaT = 0;
  let proximaCara = 0;
  let proximaDeteccion = 0;
  let costoDeteccion = 0; // ms que tarda una deteccion (media movil)
  let ritmoMinMs = 0; // separacion minima entre detecciones (se sube cuando nadie usa las manos)
  let factorCosto = 1; // tras cada deteccion se espera `factor` x lo que tardo (1 = hasta la mitad del tiempo; 2,5 = ~30 %)

  // Se despierta SOLO cuando la camara entrega un cuadro nuevo (30/s) en vez de en cada vuelta de la
  // pantalla (60/s): la mitad de despertares inutiles. Si el navegador no sabe, vuelve al metodo de antes.
  const proximoCuadro = (f) => (video.requestVideoFrameCallback ? video.requestVideoFrameCallback(() => f()) : requestAnimationFrame(f));

  function loop() {
    if (!corriendo) return;
    if (video.readyState >= 2 && video.currentTime !== ultimoT) {
      ultimoT = video.currentTime;
      const ts = performance.now();

      // Si la deteccion es cara (PC lenta, sin GPU) se espacia para que como maximo use
      // la mitad del tiempo: el hilo principal tambien dibuja la pantalla y GRABA el video,
      // y si MediaPipe se lo come todo el video sale a 3 cuadros por segundo.
      if (ts < proximaDeteccion) {
        proximoCuadro(loop);
        return;
      }
      let manosRes;
      try {
        manosRes = handLandmarker.detectForVideo(video, ts);
      } catch (err) {
        console.warn('[vision] manos:', err.message);
      }
      const costo = performance.now() - ts;
      costoDeteccion = costoDeteccion ? costoDeteccion * 0.8 + costo * 0.2 : costo;
      proximaDeteccion = ts + Math.max(ritmoMinMs, Math.min(500, costoDeteccion * factorCosto));

      if (faceDetector && ts >= proximaCara) {
        proximaCara = ts + Math.max(350, ritmoMinMs);
        try {
          const f = faceDetector.detectForVideo(video, ts);
          hayPersona = (f?.detections?.length || 0) > 0;
          const bb = f?.detections?.[0]?.boundingBox;
          if (bb && video.videoWidth) {
            cara = {
              cx: 1 - (bb.originX + bb.width / 2) / video.videoWidth,
              cy: (bb.originY + bb.height / 2) / video.videoHeight,
              w: bb.width / video.videoWidth,
              h: bb.height / video.videoHeight,
            };
            caraVistaT = ts;
          }
        } catch {
          /* frames sueltos */
        }
      }

      const detecciones = crudas(manosRes);
      // la cara se recuerda 1.5 s: la deteccion es a ~3 fps y puede fallar un tick
      onResultado({
        detecciones,
        hayPersona: hayPersona || detecciones.length > 0,
        cara: ts - caraVistaT < 1500 ? cara : null,
        ts,
      });
    }
    proximoCuadro(loop);
  }
  proximoCuadro(loop);

  return {
    // `ms` = cada cuanto detectar como minimo (0 = lo mas rapido que se pueda). Cuando nadie usa las manos
    // (esperando / resultado) alcanza con unas pocas detecciones por segundo.
    setRitmo: (ms = 0) => { ritmoMinMs = Math.max(0, Number(ms) || 0); },
    // modo liviano: la deteccion usa menos tiempo de la compu (las manos se actualizan menos seguido)
    setFactor: (f = 1) => { factorCosto = Math.max(1, Number(f) || 1); },
    detener: () => {
      corriendo = false;
      handLandmarker.close?.();
      faceDetector?.close?.();
    },
  };
}

async function crearCon(Clase, fileset, opciones) {
  try {
    return await Clase.createFromOptions(fileset, {
      ...opciones,
      baseOptions: { ...opciones.baseOptions, delegate: 'GPU' },
    });
  } catch (err) {
    console.warn(`[vision] ${Clase.name} sin GPU, uso CPU:`, err.message);
    return await Clase.createFromOptions(fileset, {
      ...opciones,
      baseOptions: { ...opciones.baseOptions, delegate: 'CPU' },
    });
  }
}

// 21 puntos por mano, normalizados 0..1 y ESPEJADOS en x (como se ve en pantalla).
// La etiqueta Left/Right de MediaPipe NO se usa: con la imagen sin espejar queda
// invertida y con dos manos suele repetirse. El lado se deduce de la posicion.
function crudas(res) {
  const lms = res?.landmarks || [];
  return lms.map((pts, i) => ({
    puntos: pts.map((p) => ({ x: 1 - p.x, y: p.y, z: p.z })),
    puntaje: res.handednesses?.[i]?.[0]?.score ?? 0,
  }));
}

function esperarVideo(video) {
  return new Promise((resolve) => {
    if (video.videoWidth) return resolve();
    video.addEventListener('loadeddata', () => resolve(), { once: true });
    setTimeout(resolve, 5000);
  });
}
