import { describe, expect, it, vi } from "vitest";
import { GEOLOCATION_MESSAGES, getCurrentLocation } from "./geolocation";

function fakeGeolocation({ position, error }) {
  return {
    getCurrentPosition: vi.fn((onSuccess, onError) => {
      if (error) onError(error);
      else onSuccess(position);
    }),
  };
}

async function rejectionOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected rejection");
}

describe("getCurrentLocation", () => {
  it("resolves {lat, lng} when permission is granted", async () => {
    const geolocation = fakeGeolocation({
      position: { coords: { latitude: 35.1709, longitude: 136.8815, accuracy: 20 } },
    });

    await expect(getCurrentLocation(geolocation)).resolves.toEqual({ lat: 35.1709, lng: 136.8815 });
    // バッテリー消費を抑えた設定で1回だけ問い合わせる。
    const options = geolocation.getCurrentPosition.mock.calls[0][2];
    expect(geolocation.getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(options.enableHighAccuracy).toBe(false);
    expect(options.timeout).toBeGreaterThan(0);
  });

  it.each([
    [1, "denied"],
    [2, "unavailable"],
    [3, "timeout"],
    [99, "unavailable"],
  ])("maps error code %s to a Japanese fallback message (%s)", async (code, reason) => {
    const error = await rejectionOf(getCurrentLocation(fakeGeolocation({ error: { code } })));

    expect(error.reason).toBe(reason);
    expect(error.userMessage).toBe(GEOLOCATION_MESSAGES[reason]);
    expect(error.userMessage).toMatch(/出発地を入力してください/);
  });

  it.each([undefined, null, {}])("rejects as unsupported when geolocation is not available (%s)", async (geolocation) => {
    const error = await rejectionOf(getCurrentLocation(geolocation));
    expect(error.reason).toBe("unsupported");
    expect(error.userMessage).toBe(GEOLOCATION_MESSAGES.unsupported);
  });

  it.each([
    { coords: { latitude: Number.NaN, longitude: 136.8 } },
    { coords: { latitude: 95, longitude: 136.8 } },
    { coords: {} },
    {},
  ])("rejects impossible coordinates as unavailable", async (position) => {
    const error = await rejectionOf(getCurrentLocation(fakeGeolocation({ position })));
    expect(error.reason).toBe("unavailable");
  });
});
