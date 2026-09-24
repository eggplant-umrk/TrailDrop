import { useEffect, useRef, useState } from "react";

// スタッフ画面用のQRコードカメラ読み取り。
// - 読み取りはブラウザ標準のBarcodeDetector(Android Chromeなど)を優先し、
//   未対応ブラウザ(iOS Safariなど)ではjsQRで解析する。jsQRはスキャン開始時
//   にだけ動的importし、通常の画面表示時のバンドルには含めない。
// - 1回読み取ったら即座に解析とカメラを止め、onDetectedを1度だけ呼ぶ
//   (同じQRを映し続けても複数回通知しない)。
// - 読み取った値はログ・画面に出さない(呼び出し側へ渡すだけ)。

const SCAN_INTERVAL_MS = 200;
// jsQRで解析する際の最大幅。大きいフレームをそのまま解析すると低速端末で
// 重くなるため縮小する(QR 1個を読む用途では十分な解像度)。
const MAX_DECODE_WIDTH = 640;

function describeCameraError(cameraError) {
  switch (cameraError?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "カメラの使用が許可されていません。ブラウザの設定でこのサイトのカメラを許可してから、もう一度お試しください。";
    case "NotFoundError":
    case "OverconstrainedError":
      return "利用できるカメラが見つかりませんでした。";
    case "NotReadableError":
    case "AbortError":
      return "カメラを起動できませんでした。他のアプリがカメラを使用していないか確認してください。";
    default:
      return "カメラを起動できませんでした。";
  }
}

async function createDetector() {
  if (typeof window !== "undefined" && "BarcodeDetector" in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes("qr_code")) {
        const detector = new window.BarcodeDetector({ formats: ["qr_code"] });
        return async (video) => {
          const codes = await detector.detect(video);
          return codes[0]?.rawValue || null;
        };
      }
    } catch {
      // BarcodeDetectorが使えない場合はjsQRへフォールバックする。
    }
  }

  const { default: jsQR } = await import("jsqr");
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  return async (video) => {
    const { videoWidth, videoHeight } = video;
    if (!videoWidth || !videoHeight) return null;
    const scale = Math.min(1, MAX_DECODE_WIDTH / videoWidth);
    const width = Math.round(videoWidth * scale);
    const height = Math.round(videoHeight * scale);
    canvas.width = width;
    canvas.height = height;
    context.drawImage(video, 0, 0, width, height);
    const image = context.getImageData(0, 0, width, height);
    const code = jsQR(image.data, width, height, { inversionAttempts: "dontInvert" });
    return code?.data || null;
  };
}

export default function QrScanner({ onDetected, onCancel }) {
  const videoRef = useRef(null);
  const [status, setStatus] = useState("starting"); // starting | scanning | error
  const [errorMessage, setErrorMessage] = useState("");
  // 親の再レンダーでonDetectedが差し替わってもカメラを再起動しないよう、
  // 最新のコールバックはrefで参照する。
  const onDetectedRef = useRef(onDetected);
  onDetectedRef.current = onDetected;

  useEffect(() => {
    let stopped = false;
    let stream = null;
    let timerId = null;

    function stopCamera() {
      stopped = true;
      if (timerId) clearTimeout(timerId);
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
        stream = null;
      }
    }

    async function start() {
      if (!window.isSecureContext) {
        setErrorMessage(
          "この接続ではカメラを利用できません。カメラ読み取りはHTTPSで開いた画面でのみ利用できます。"
        );
        setStatus("error");
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        setErrorMessage("このブラウザはカメラ読み取りに対応していません。");
        setStatus("error");
        return;
      }

      try {
        const mediaStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        if (stopped) {
          // 起動待ちの間にキャンセル/アンマウントされた。
          mediaStream.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = mediaStream;

        const video = videoRef.current;
        video.srcObject = mediaStream;
        await video.play();

        const detect = await createDetector();
        if (stopped) return;
        setStatus("scanning");

        const tick = async () => {
          if (stopped) return;
          let value = null;
          try {
            if (video.readyState >= video.HAVE_ENOUGH_DATA) {
              value = await detect(video);
            }
          } catch {
            value = null;
          }
          if (stopped) return;
          const trimmed = typeof value === "string" ? value.trim() : "";
          if (trimmed) {
            stopCamera();
            onDetectedRef.current(trimmed);
            return;
          }
          timerId = setTimeout(tick, SCAN_INTERVAL_MS);
        };
        tick();
      } catch (cameraError) {
        if (stopped) return;
        stopCamera();
        setErrorMessage(describeCameraError(cameraError));
        setStatus("error");
      }
    }

    start();
    return stopCamera;
  }, []);

  return (
    <div className="space-y-3 rounded-md border border-gray-200 p-3">
      {status === "error" ? (
        <p className="text-sm text-red-600" role="alert">
          {errorMessage}
          <span className="mt-1 block text-gray-600">
            下のQRトークン欄に手入力して受取確認できます。
          </span>
        </p>
      ) : (
        <>
          <div className="relative mx-auto aspect-square w-full max-w-xs overflow-hidden rounded bg-black">
            <video
              ref={videoRef}
              className="h-full w-full object-cover"
              playsInline
              muted
              autoPlay
            />
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-[15%] rounded-md border-4 border-white/90"
            />
          </div>
          <p className="text-center text-sm font-medium" aria-live="polite">
            {status === "starting" ? "カメラを起動しています…" : "QRコードを枠内に合わせてください"}
          </p>
        </>
      )}
      <button
        type="button"
        onClick={onCancel}
        className="w-full rounded border border-gray-300 bg-white px-4 py-2 font-medium text-gray-700"
      >
        {status === "error" ? "閉じる" : "キャンセル"}
      </button>
    </div>
  );
}
