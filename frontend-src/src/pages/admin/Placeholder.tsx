import { PageHead } from "@/components/PageHead";
import { EmptyState } from "@/components/EmptyState";

// Used for the admin routes that exist in the navigation map but whose
// backend endpoints aren't implemented yet. The Aham rule for placeholders
// is "explain the state in one sentence; no big illustration".
export function AdminPlaceholder({
  route,
  title,
  needs,
}: {
  route: string;
  title: string;
  needs: string;
}) {
  return (
    <div className="page-body page--object-index">
      <PageHead
        title={title}
        subtitle={`这一页留了一个空位 (${route})，等后端补齐 API 后再启用。`}
      />
      <EmptyState description={needs} />
    </div>
  );
}
