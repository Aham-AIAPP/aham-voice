import { Hotwords } from "@/pages/app/Hotwords";

// The admin "热词总览" and the user-side hotwords page show the same data
// surface — the canonical hotwords table with all sync controls. The user-
// page-level access check already covers both admin and manager. Just re-use
// the implementation; if admin gets unique controls later, fork here.
export function AdminHotwords() {
  return <Hotwords />;
}
