import { type JSX, useState } from "react";
import { create_text_resolver } from "@shared/i18n";
import {
  resolve_app_language_from_locale_tag,
  resolve_app_locale,
} from "@domain/app-language";

import { Input } from "@frontend/shadcn/input";
import { AppButton } from "@frontend/widgets/app-button";
import { WEB_ACCESS_CREDENTIAL_HASH_KEY } from "@frontend/app/desktop/web-host-api";
import { establish_web_access_session } from "@frontend/app/host/web-host-bridge";
import "./web-access-gate.css";

type WebAccessGateProps = {
  on_established: () => void;
};

/**
 * 访问凭据录入视图。Web 服务在建立会话前不开放业务 API，
 * 这里只承接一次性启动凭据，不提供任何绕过入口。
 */
export function WebAccessGate(props: WebAccessGateProps): JSX.Element {
  const text = create_text_resolver(
    resolve_app_locale(resolve_app_language_from_locale_tag(window.navigator.language)),
  );
  const [credential, set_credential] = useState(() =>
    new URLSearchParams(
      window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash,
    ).get(WEB_ACCESS_CREDENTIAL_HASH_KEY) ?? "",
  );
  const [is_submitting, set_is_submitting] = useState(false);
  const [error_message, set_error_message] = useState<string | null>(null);

  async function handle_submit(): Promise<void> {
    set_is_submitting(true);
    set_error_message(null);
    try {
      await establish_web_access_session(credential.trim());
      props.on_established();
    } catch {
      set_error_message(text("app.web_access.failed"));
    } finally {
      set_is_submitting(false);
    }
  }

  return (
    <main className="web-access-gate" role="main">
      <section className="web-access-gate__panel">
        <p className="web-access-gate__eyebrow">{text("app.metadata.app_name")}</p>
        <h1 className="web-access-gate__title">{text("app.web_access.title")}</h1>
        <p className="web-access-gate__description">{text("app.web_access.description")}</p>
        <form
          className="web-access-gate__form"
          onSubmit={(event) => {
            event.preventDefault();
            void handle_submit();
          }}
        >
          <label className="web-access-gate__label" htmlFor="web-access-credential">
            {text("app.web_access.placeholder")}
          </label>
          <Input
            id="web-access-credential"
            name="credential"
            value={credential}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => set_credential(event.target.value)}
          />
          {error_message === null ? null : (
            <p className="web-access-gate__error" role="alert">
              {error_message}
            </p>
          )}
          <AppButton type="submit" disabled={is_submitting || credential.trim() === ""}>
            {text("app.web_access.submit")}
          </AppButton>
        </form>
      </section>
    </main>
  );
}
