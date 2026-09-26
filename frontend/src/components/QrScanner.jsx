import { useEffect, useRef, useState } from "react";
import { isUuid } from "../utils/uuid";

// スタッフ画面用のQRコードカメラ読み取り。
// - 読み取りはブラウザ標準のBarcodeDetector(Android Chromeなど)を優先し、
//   未対応ブラウザ(iOS Safariなど)ではjsQRで解析する。jsQRはスキャン開始時
//   にだけ動的importし、通常の画面表示時のバンドルには含めない。
// - BarcodeDetectorが存在しても実際のdetect()が実行時に失敗する環境が
//   あるため、その場合は同じカメラストリームを維持したままjsQRへ切り替える
//   (一度切り替えたらBarcodeDetectorには戻さない)。
// - 1回読み取ったら即座に解析とカメラを止め、onDetectedを1度だけ呼ぶ
//   (同じQRを映し続けても複数回通知しない)。読み取った値がUUID形式
//   (TrailDropのqr_token)でない場合は無視してスキャンを継続する。
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

async function createJsQrDetector() {
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

async function createDetector() {
  if (typeof window !== "undefined" && "BarcodeDetector" in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes("qr_code")) {
        const detector = new window.BarcodeDetector({ formats: ["qr_code"] });
        // null: BarcodeDetectorを使用中。function: jsQRへ切替済み。
        // "failed": jsQRへの切替自体にも失敗した(致命的エラーとして扱う)。
        let fallback = null;
        return async (video) => {
          if (!fallback) {
            try {
              const codes = await detector.detect(video);
              return codes[0]?.rawValue || null;
            } catch {
              // detect()が実行時に失敗する環境ではjsQRへ切り替える。
              // カメラストリームはそのまま維持し、以降はjsQRのみを使う。
              try {
                fallback = await createJsQrDetector();
              } catch {
                fallback = "failed";
              }
            }
          }
          if (fallback === "failed") {
            throw new Error("QRコードの読み取りに失敗しました。");
          }
          return fallback(video);
        };
      }
    } catch {
      // BarcodeDetectorが使えない場合はjsQRへフォールバックする。
    }
  }

  return createJsQrDetector();
}

export default function QrScanner({
  onDetected,
  onCancel,
  showManualEntryHint = true,
  displaySize = "default",
}) {
  const videoRef = useRef(null);
  const isLargeDisplay = displaySize === "large";
  const [status, setStatus] = useState("starting"); // starting | scanning | error
  const [errorMessage, setErrorMessage] = useState("");
  // UUID形式でない値を読み取った際に一時的に表示する案内。
  const [invalidHint, setInvalidHint] = useState(false);
  // 親の再レンダーでonDetectedが差し替わってもカメラを再起動しないよう、
  // 最新のコールバックはrefで参照する。
  const onDetectedRef = useRef(onDetected);
  onDetectedRef.current = onDetected;

  useEffect(() => {
    let stopped = false;
    let stream = null;
    let timerId = null;
    let invalidHintTimerId = null;

    function stopCamera() {
      stopped = true;
      if (timerId) clearTimeout(timerId);
      if (invalidHintTimerId) clearTimeout(invalidHintTimerId);
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
            // BarcodeDetector→jsQRへのフォールバック自体が失敗した場合など、
            // 読み取りを継続できない致命的なエラー。手入力の案内へつなげる。
            stopCamera();
            setErrorMessage("カメラ読み取りに失敗しました。");
            setStatus("error");
            return;
          }
          if (stopped) return;
          const trimmed = typeof value === "string" ? value.trim() : "";
          if (trimmed) {
            if (isUuid(trimmed)) {
              stopCamera();
              onDetectedRef.current(trimmed);
              return;
            }
            // TrailDropのQRコード(UUID形式)ではない値はBackendへ送らず、
            // 一時的な案内を出してスキャンを続ける。
            setInvalidHint(true);
            if (invalidHintTimerId) clearTimeout(invalidHintTimerId);
            invalidHintTimerId = setTimeout(() => {
              if (!stopped) setInvalidHint(false);
            }, 1500);
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
    <div
      className={`rounded-md border border-gray-200 bg-white ${
        isLargeDisplay ? "space-y-5 p-4 sm:p-5" : "space-y-3 p-3"
      }`}
    >
      {status === "error" ? (
        <p className="text-sm text-red-600" role="alert">
          {errorMessage}
          {showManualEntryHint && (
            <span className="mt-1 block text-gray-600">
              下のQRトークン欄に手入力して受取確認できます。
            </span>
          )}
        </p>
      ) : (
        <>
          <div
            className={`relative mx-auto aspect-square w-full overflow-hidden rounded bg-black ${
              isLargeDisplay ? "max-w-[min(640px,60vh)]" : "max-w-xs"
            }`}
          >
            <video
              ref={videoRef}
              className="h-full w-full object-cover"
              playsInline
              muted
              autoPlay
            />
            <div
              aria-hidden="true"
              className={`pointer-events-none absolute inset-[15%] rounded-md border-white/90 ${
                isLargeDisplay ? "border-[6px]" : "border-4"
              }`}
            />
          </div>
          <p
            className={`text-center font-medium ${
              isLargeDisplay ? "text-lg sm:text-2xl" : "text-sm"
            }`}
            aria-live="polite"
          >
            {status === "starting"
              ? "カメラを起動しています…"
              : invalidHint
                ? "TrailDropのQRコードではありません"
                : "QRコードを枠内に合わせてください"}
          </p>
        </>
      )}
      <button
        type="button"
        onClick={onCancel}
        className={`rounded border border-gray-300 bg-white font-medium text-gray-700 ${
          isLargeDisplay
            ? "mx-auto block min-h-11 w-full max-w-xs px-4 py-2 text-sm"
            : "w-full px-4 py-2"
        }`}
      >
        {status === "error" ? "閉じる" : "キャンセル"}
      </button>
    </div>
  );
}
