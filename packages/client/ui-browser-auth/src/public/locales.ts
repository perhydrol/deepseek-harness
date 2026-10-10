/** Complete standalone authentication copy; no private plugin bootstrap is needed. */
export const zh = {
  title: 'DeepSeek Harness', login: '登录', loginDescription: '输入密码或使用通行密钥继续。',
  password: '密码', loginPassword: '使用密码登录', loginPasskey: '使用通行密钥登录',
  security: '登录与安全', securityDescription: '管理此浏览器会话、通行密钥和登录密码。',
  loading: '正在加载…', pending: '正在处理…', saved: '已保存', back: '返回应用',
  logout: '退出当前浏览器', logoutAll: '退出所有浏览器', passkeys: '通行密钥', noPasskeys: '尚未添加通行密钥。',
  label: '通行密钥名称', register: '添加通行密钥', rename: '重命名', remove: '删除',
  reauth: '敏感操作验证', reauthDescription: '每项敏感操作都需要重新验证。密码不会保留。',
  method: '验证方式', passwordMethod: '密码', passkeyMethod: '通行密钥',
  currentPassword: '当前密码', newPassword: '新密码', confirmPassword: '再次输入新密码', changePassword: '修改密码',
  passwordMismatch: '两次输入的新密码不一致。', passwordPolicy: '密码长度不符合配置要求。',
  invalidCredentials: '验证未通过，请重试。', forbidden: '验证已过期或无效，请重新验证后重试。',
  network: '连接中断。请检查网络后重试。', unavailable: '暂时无法完成操作，请稍后重试。',
  cancelled: '通行密钥验证未完成。你可以重试或使用密码。', unsupported: '此浏览器或连接不支持通行密钥，请使用密码。',
  busy: '尝试次数过多或服务繁忙，请稍后重试。', capacity: '已达到数量上限，请先删除不再使用的通行密钥或会话。',
  sessionCount: '有效浏览器会话', created: '添加时间', lastUsed: '上次使用', neverUsed: '尚未使用',
} satisfies Record<string, string>
/** Standalone and settings-entry translation keys. */
export type AuthKey = keyof typeof zh
/** English dictionary shares the Chinese key set. */
export const en = {
  title: 'DeepSeek Harness', login: 'Sign in', loginDescription: 'Enter your password or use a passkey to continue.',
  password: 'Password', loginPassword: 'Sign in with password', loginPasskey: 'Sign in with passkey',
  security: 'Sign-in and security', securityDescription: 'Manage this browser session, passkeys and your sign-in password.',
  loading: 'Loading…', pending: 'Working…', saved: 'Saved', back: 'Back to app',
  logout: 'Sign out of this browser', logoutAll: 'Sign out of all browsers', passkeys: 'Passkeys', noPasskeys: 'No passkeys added yet.',
  label: 'Passkey name', register: 'Add passkey', rename: 'Rename', remove: 'Delete',
  reauth: 'Verify sensitive changes', reauthDescription: 'Each sensitive change requires fresh verification. Your password is not retained.',
  method: 'Verification method', passwordMethod: 'Password', passkeyMethod: 'Passkey',
  currentPassword: 'Current password', newPassword: 'New password', confirmPassword: 'Repeat new password', changePassword: 'Change password',
  passwordMismatch: 'The new passwords do not match.', passwordPolicy: 'The password does not meet the configured length requirements.',
  invalidCredentials: 'Verification failed. Please try again.', forbidden: 'Verification expired or is invalid. Verify again and retry.',
  network: 'Connection interrupted. Check your network and retry.', unavailable: 'Unable to complete this operation. Please try again later.',
  cancelled: 'Passkey verification was not completed. Retry or use your password.', unsupported: 'This browser or connection does not support passkeys. Use your password.',
  busy: 'Too many attempts or the service is busy. Please try again later.', capacity: 'The limit has been reached. Remove unused passkeys or sessions first.',
  sessionCount: 'Active browser sessions', created: 'Added', lastUsed: 'Last used', neverUsed: 'Not used yet',
} satisfies Record<AuthKey, string>
/**
 * Select the authentication page dictionary from the browser language.
 * @param language - browser language.
 * @returns complete lookup without private locale state.
 */
export function authTranslator(language: string): (key: AuthKey) => string {
  const dictionary = language.toLowerCase().startsWith('zh') ? zh : en
  return key => dictionary[key]
}
