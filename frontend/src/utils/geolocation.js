// RouteTestの「現在地を使う」用。navigator.geolocationをPromiseにし、失敗時は
// 出発地の手入力へ戻すための日本語メッセージ(userMessage)付きのErrorにする。
// 取得した座標はルート分析の出発地としてBackendへ送るだけで、この端末にも
// 保存しない。
// ※ブラウザの仕様上、HTTPS(またはlocalhost)でしか利用できない。

export const GEOLOCATION_MESSAGES = {
  unsupported: "この端末・ブラウザでは現在地を取得できません。出発地を入力してください。",
  denied: "現在地の利用が許可されませんでした。出発地を入力してください。",
  unavailable: "現在地を取得できませんでした。出発地を入力してください。",
  timeout: "現在地の取得に時間がかかっています。出発地を入力してください。",
};

// GeolocationPositionErrorのcode: 1=PERMISSION_DENIED, 2=POSITION_UNAVAILABLE, 3=TIMEOUT
const REASON_BY_CODE = { 1: "denied", 2: "unavailable", 3: "timeout" };

const DEFAULT_OPTIONS = { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 };

function geolocationError(reason) {
  const error = new Error(GEOLOCATION_MESSAGES[reason]);
  error.reason = reason;
  error.userMessage = GEOLOCATION_MESSAGES[reason];
  return error;
}

function defaultGeolocation() {
  return typeof navigator !== "undefined" ? navigator.geolocation : undefined;
}

export function getCurrentLocation(geolocation = defaultGeolocation(), options = DEFAULT_OPTIONS) {
  return new Promise((resolve, reject) => {
    if (!geolocation || typeof geolocation.getCurrentPosition !== "function") {
      reject(geolocationError("unsupported"));
      return;
    }
    geolocation.getCurrentPosition(
      (position) => {
        const lat = position?.coords?.latitude;
        const lng = position?.coords?.longitude;
        const valid =
          Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
        if (valid) resolve({ lat, lng });
        else reject(geolocationError("unavailable"));
      },
      (error) => reject(geolocationError(REASON_BY_CODE[error?.code] || "unavailable")),
      options,
    );
  });
}
