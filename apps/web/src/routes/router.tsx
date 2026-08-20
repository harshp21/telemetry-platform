import { createBrowserRouter } from "react-router-dom";
import App from "@/App";

const Placeholder = ({ title }: { title: string }): JSX.Element => {
  return (
    <section>
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="mt-2 text-slate-600">Initial scaffold page.</p>
    </section>
  );
};

export const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    children: [
      { index: true, element: <Placeholder title="Telemetry Dashboard" /> },
      { path: "usage", element: <Placeholder title="Usage Analytics" /> },
      { path: "billing", element: <Placeholder title="Billing Overview" /> }
    ]
  }
]);
