import type { ReactNode } from "react";
export function Message({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return children ? (
    <p
      className={error ? "message error" : "message"}
      role={error ? "alert" : "status"}
    >
      {children}
    </p>
  ) : null;
}
