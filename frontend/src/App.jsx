import { BrowserRouter, Routes, Route } from "react-router-dom";
import ItemList from "./pages/ItemList";
import Reservation from "./pages/Reservation";
import ReservationComplete from "./pages/ReservationComplete";
import RouteTest from "./pages/RouteTest";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<ItemList />} />
        <Route path="/reserve/:id" element={<Reservation />} />
        <Route path="/complete/:id" element={<ReservationComplete />} />
        <Route path="/route-test" element={<RouteTest />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
