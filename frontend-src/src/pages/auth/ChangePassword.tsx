import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/context/auth";
import { Field, FormRow } from "@/components/Field";
import { Button } from "@/components/Button";
import { Diag } from "@/components/Diag";
import { readApiError } from "@/api/client";

export function ChangePassword() {
  const { user, changePassword } = useAuth();
  const navigate = useNavigate();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const mismatch = confirm !== "" && confirm !== next;
  const tooShort = next.length > 0 && next.length < 8;
  const sameAsCurrent = next.length > 0 && next === current;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (mismatch) {
      setError("两次输入的新密码不一致。");
      return;
    }
    if (tooShort) {
      setError("新密码至少 8 位。");
      return;
    }
    if (sameAsCurrent) {
      setError("新密码不能与当前密码相同。");
      return;
    }
    setSubmitting(true);
    try {
      const updated = await changePassword(current, next);
      navigate(updated.role === "admin" ? "/admin/overview" : "/app/recordings/new", { replace: true });
    } catch (err) {
      setError(readApiError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit}>
      <h1 className="auth-form__title">
        设置 <em>新密码</em>
      </h1>
      <p className="auth-form__lede">
        {user?.must_change_password
          ? "首次登录需要修改密码。"
          : "更换登录密码后所有设备会保持登录，除非管理员撤销。"}
      </p>

      <FormRow label="当前密码" htmlFor="cp-current">
        <Field
          id="cp-current"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          required
          autoFocus
        />
      </FormRow>

      <FormRow label="新密码" htmlFor="cp-next" hint="至少 8 个字符。" error={tooShort ? "至少 8 个字符。" : undefined}>
        <Field
          id="cp-next"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          minLength={8}
          required
        />
      </FormRow>

      <FormRow label="再输入一次" htmlFor="cp-confirm" error={mismatch ? "与新密码不一致。" : undefined}>
        <Field
          id="cp-confirm"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          minLength={8}
          required
          invalid={mismatch}
        />
      </FormRow>

      {error && (
        <Diag code="AUTH_E_PASSWORD" tone="danger">
          {error}
        </Diag>
      )}

      <Button
        type="submit"
        variant="primary"
        className="auth-form__primary"
        loading={submitting}
        disabled={!current || !next || !confirm || mismatch || tooShort}
      >
        保存新密码
      </Button>
    </form>
  );
}
