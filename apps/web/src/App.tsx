import { Link, Outlet } from "react-router-dom";

export default function App(): JSX.Element {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b bg-white">
        <nav className="mx-auto flex max-w-5xl gap-4 px-6 py-4 text-sm font-medium">
          <Link to="/">Dashboard</Link>
          <Link to="/usage">Usage</Link>
          <Link to="/billing">Billing</Link>
        </nav>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-10">
        <Outlet />
      </main>
    </div>
  );
}
