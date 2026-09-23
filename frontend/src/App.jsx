import { BrowserRouter, Routes, Route } from "react-router-dom";
import ItemList from "./pages/ItemList";
import Reservation from "./pages/Reservation";
import ReservationComplete from "./pages/ReservationComplete";
import RouteTest from "./pages/RouteTest";
import StaffVerify from "./pages/StaffVerify";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<ItemList />} />
        <Route path="/reserve/:id" element={<Reservation />} />
        <Route path="/complete/:id" element={<ReservationComplete />} />
        <Route path="/route-test" element={<RouteTest />} />
        <Route path="/staff/verify" element={<StaffVerify />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
