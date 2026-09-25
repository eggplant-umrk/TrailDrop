import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Vitest設定。ビルド(npm run build)には影響しない。jsdomはlocalStorage/
  // sessionStorageを使う純粋関数のテスト(reservationAccess.js等)のために
  // 必要。
  test: {
    environment: "jsdom",
  },
});
