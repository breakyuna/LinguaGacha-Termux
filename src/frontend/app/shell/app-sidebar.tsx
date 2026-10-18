import type { JSX } from "react";
import { ChevronDown, Languages, ScrollText } from "lucide-react";

import type { NavigationGroup, RouteId } from "@frontend/app/navigation/types";
import { is_app_language, type AppLanguage } from "@domain/app-language";
import { APP_LANGUAGE_DEFINITIONS } from "@domain/app-language";
import { AppAppearanceMenu } from "@frontend/app/shell/app-appearance-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "@frontend/shadcn/sidebar";
import { useSidebar } from "@frontend/shadcn/sidebar-context";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@frontend/shadcn/sheet";
import { useI18n, type LocaleKey } from "@frontend/app/locale/locale-context";
import { cn } from "@frontend/shadcn/classnames";
import { useNarrowViewport } from "@frontend/app/shell/use-narrow-viewport";
import {
  AppDropdownMenu,
  AppDropdownMenuContent,
  AppDropdownMenuRadioGroup,
  AppDropdownMenuRadioItem,
  AppDropdownMenuTrigger,
} from "@frontend/widgets/app-dropdown-menu";
import "@frontend/app/shell/app-sidebar.css";

const SIDEBAR_PROFILE_ICON_URL: string = new URL("icon.png", document.baseURI).toString();

type AppSidebarProps = {
  groups: NavigationGroup[];
  selected_route: RouteId;
  expanded_items: ReadonlySet<RouteId>;
  disabled_route_ids: ReadonlySet<RouteId>;
  app_language: AppLanguage;
  is_language_updating: boolean;
  show_log_badge: boolean;
  profile_label_key: LocaleKey;
  profile_tooltip_key: LocaleKey;
  is_profile_update_available: boolean;
  on_select_route: (route_id: RouteId) => void;
  on_toggle_group: (route_id: RouteId) => void;
  on_open_logs: () => void;
  on_select_app_language: (language: AppLanguage) => void;
  on_profile_action: () => void;
};

type AppSidebarNavigationProps = AppSidebarProps & {
  /** 触屏路径下选中导航即收起抽屉，桌面并排侧栏没有对应动作。 */
  on_navigate?: () => void;
};

/**
 * 窄视口把导航收进抽屉，宽视口保持并排侧栏。
 * 抽屉开关仍由 SidebarProvider 的展开态驱动，不新建第二套导航状态。
 */
export function AppSidebar(props: AppSidebarProps): JSX.Element {
  const { t } = useI18n();
  const is_narrow_viewport = useNarrowViewport();
  const { open, setOpen } = useSidebar();

  if (is_narrow_viewport) {
    return (
      <Sheet
        open={open}
        onOpenChange={(is_open) => {
          setOpen(is_open);
        }}
      >
        <SheetContent
          side="left"
          showCloseButton={false}
          className="shell-sidebar shell-sidebar-drawer"
        >
          {/* 抽屉的无障碍名称复用应用名，与标题栏可见文案一致。 */}
          <SheetHeader className="sr-only">
            <SheetTitle>{t("app.metadata.app_name")}</SheetTitle>
          </SheetHeader>
          <AppSidebarNavigation
            {...props}
            on_navigate={() => {
              setOpen(false);
            }}
          />
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Sidebar className="shell-sidebar top-[var(--titlebar-height,0px)] h-[calc(100dvh-var(--titlebar-height,0px))]">
      <AppSidebarNavigation {...props} />
    </Sidebar>
  );
}

/** 导航与语言选择由宿主状态驱动，侧栏只提交用户操作；两种形态共用同一份内容。 */
function AppSidebarNavigation(props: AppSidebarNavigationProps): JSX.Element {
  const { t } = useI18n();
  const { state } = useSidebar();
  const is_collapsed = state === "collapsed";

  return (
    <>
      <SidebarContent className="shell-sidebar__scroll">
        {props.groups.map((group, group_index) => (
          <div key={group.id}>
            {group_index > 0 ? <SidebarSeparator className="sidebar-group-separator" /> : null}
            <SidebarGroup className="sidebar-group">
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    const has_children = (item.children?.length ?? 0) > 0;
                    const has_active_child =
                      item.children?.some((child) => child.id === props.selected_route) ?? false;
                    const is_active = props.selected_route === item.id;
                    const is_expanded = has_children && props.expanded_items.has(item.id);
                    const is_subitems_open = !is_collapsed && is_expanded;
                    const is_disabled =
                      props.disabled_route_ids.has(item.id) ||
                      (has_children &&
                        (item.children?.every((child) => {
                          return props.disabled_route_ids.has(child.id);
                        }) ??
                          false));

                    return (
                      <SidebarMenuItem key={item.id}>
                        <SidebarMenuButton
                          className={cn(
                            "sidebar-row",
                            !is_active && has_active_child && "sidebar-row--parent-active",
                          )}
                          isActive={is_active}
                          disabled={is_disabled}
                          tooltip={t(item.title_key)}
                          onClick={() => {
                            if (has_children) {
                              props.on_toggle_group(item.id);
                            }
                            props.on_select_route(item.id);
                            props.on_navigate?.();
                          }}
                          aria-label={t(item.title_key)}
                        >
                          <Icon className="sidebar-row__icon" />
                          <span className="sidebar-row__label">{t(item.title_key)}</span>
                          {has_children ? (
                            <ChevronDown
                              className={cn(
                                "sidebar-item__chevron",
                                is_expanded && "sidebar-item__chevron--expanded",
                              )}
                            />
                          ) : null}
                        </SidebarMenuButton>
                        {has_children ? (
                          <div
                            className={cn(
                              "sidebar-subitems-shell",
                              is_subitems_open && "sidebar-subitems-shell--expanded",
                            )}
                            aria-hidden={!is_subitems_open}
                          >
                            <SidebarMenu className="sidebar-subitems">
                              {item.children?.map((child) => {
                                const ChildIcon = child.icon;
                                const is_child_active = child.id === props.selected_route;
                                const is_child_disabled = props.disabled_route_ids.has(child.id);

                                return (
                                  <SidebarMenuItem key={child.id}>
                                    <SidebarMenuButton
                                      isActive={is_child_active}
                                      className="sidebar-row"
                                      disabled={is_child_disabled}
                                      onClick={() => {
                                        props.on_select_route(child.id);
                                        props.on_navigate?.();
                                      }}
                                      aria-label={t(child.title_key)}
                                      tabIndex={is_subitems_open ? 0 : -1}
                                    >
                                      <ChildIcon className="sidebar-row__icon" />
                                      <span className="sidebar-row__label">
                                        {t(child.title_key)}
                                      </span>
                                    </SidebarMenuButton>
                                  </SidebarMenuItem>
                                );
                              })}
                            </SidebarMenu>
                          </div>
                        ) : null}
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </div>
        ))}
      </SidebarContent>

      <SidebarFooter className="shell-sidebar__bottom">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              className="sidebar-row"
              tooltip={t("app.navigation_action.logs")}
              aria-label={t("app.navigation_action.logs")}
              onClick={() => {
                props.on_open_logs();
                props.on_navigate?.();
              }}
            >
              <span className="sidebar-row__icon">
                <ScrollText size={16} />
                {props.show_log_badge ? (
                  <span className="sidebar-badge-dot" aria-hidden="true" />
                ) : null}
              </span>
              <span className="sidebar-row__label">{t("app.navigation_action.logs")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>

          <AppAppearanceMenu is_collapsed={is_collapsed} />

          <SidebarMenuItem>
            <AppDropdownMenu>
              <AppDropdownMenuTrigger
                render={
                  <SidebarMenuButton
                    className="sidebar-row"
                    disabled={props.is_language_updating}
                    aria-label={t("app.navigation_action.language")}
                  >
                    <Languages className="sidebar-row__icon" />
                    <span className="sidebar-row__label">
                      {t("app.navigation_action.language")}
                    </span>
                  </SidebarMenuButton>
                }
              />
              <AppDropdownMenuContent
                side={is_collapsed ? "right" : "top"}
                align="center"
                sideOffset={is_collapsed ? 8 : 4}
                matchTriggerWidth={!is_collapsed}
                className={cn(!is_collapsed && "w-(--anchor-width)")}
              >
                <AppDropdownMenuRadioGroup
                  value={props.app_language}
                  onValueChange={(language) => {
                    if (is_app_language(language)) {
                      props.on_select_app_language(language);
                    }
                  }}
                >
                  {APP_LANGUAGE_DEFINITIONS.map(({ code, name }) => (
                    <AppDropdownMenuRadioItem key={code} value={code}>
                      <span>{name}</span>
                    </AppDropdownMenuRadioItem>
                  ))}
                </AppDropdownMenuRadioGroup>
              </AppDropdownMenuContent>
            </AppDropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>

        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              className={cn(
                "sidebar-row",
                props.is_profile_update_available && "sidebar-profile--update",
              )}
              tooltip={t(props.profile_tooltip_key)}
              aria-label={t(props.profile_tooltip_key)}
              onClick={props.on_profile_action}
            >
              <span className="sidebar-profile__avatar">
                <img
                  className="sidebar-profile__avatar-image"
                  src={SIDEBAR_PROFILE_ICON_URL}
                  alt="LinguaGacha"
                />
                {props.is_profile_update_available ? (
                  <span className="sidebar-badge-dot" aria-hidden="true" />
                ) : null}
              </span>
              <span className="sidebar-row__label font-medium">{t(props.profile_label_key)}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}
