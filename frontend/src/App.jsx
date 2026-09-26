import { BrowserRouter, Routes, Route } from "react-router-dom";
import ItemList from "./pages/ItemList";
import Reservation from "./pages/Reservation";
import ReservationComplete from "./pages/ReservationComplete";
import RouteTest from "./pages/RouteTest";
import StaffScan from "./pages/StaffScan";
import StaffVerify from "./pages/StaffVerify";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* トップはルート検索(ルート → 受取地点 → 商品 → 予約)。商品一覧は
            「すべての商品」からの下位導線。/route-testは既存リンク互換のため残す。 */}
        <Route path="/" element={<RouteTest />} />
        <Route path="/items" element={<ItemList />} />
        <Route path="/reserve/:id" element={<Reservation />} />
        <Route path="/reserve/:id/confirm" element={<Reservation />} />
        <Route path="/complete/:id" element={<ReservationComplete />} />
        <Route path="/route-test" element={<RouteTest />} />
        <Route path="/staff/scan" element={<StaffScan />} />
        <Route path="/staff/verify" element={<StaffVerify />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
