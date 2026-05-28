import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@/context/auth";
import { Field, FormRow } from "@/components/Field";
import { Button } from "@/components/Button";
import { Diag } from "@/components/Diag";
import { readApiError } from "@/api/client";

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { from?: { pathname: string } } };
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const user = await login(username.trim(), password);
      const redirect = location.state?.from?.pathname ?? null;
      if (user.must_change_password) {
        navigate("/auth/change-password", { replace: true });
      } else if (user.role === "admin") {
        navigate(redirect && redirect !== "/login" ? redirect : "/admin/overview", { replace: true });
      } else {
        navigate(redirect && redirect !== "/login" ? redirect : "/app/workspace", { replace: true });
      }
    } catch (err) {
      setError(readApiError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit}>
      <h1 className="auth-form__title">
        登录到 <em>兰之天</em>
      </h1>
      <p className="auth-form__lede">使用公司账号继续。首次登录后会被引导设置新密码。</p>

      <FormRow label="用户名 / 邮箱 / 手机号" htmlFor="login-username">
        <Field
          id="login-username"
          name="username"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
          autoFocus
        />
      </FormRow>

      <FormRow label="密码" htmlFor="login-password">
        <Field
          id="login-password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </FormRow>

      {error && (
        <Diag code="AUTH_E_LOGIN" tone="danger">
          {error}
        </Diag>
      )}

      <Button
        type="submit"
        variant="primary"
        className="auth-form__primary"
        loading={submitting}
        disabled={!username.trim() || !password}
      >
        登录
      </Button>

      <p className="auth-form__alt">忘记密码请联系管理员重置。</p>
    </form>
  );
}
