export interface ApiUser {
  id: string;
  email: string;
  role: "admin" | "user";
  created_at?: string;
}

export interface VaultQuota {
  package: {
    total_quota_bytes: string | number;
    user_quota_bytes: string | number;
    raid_reserve_bytes: string | number;
  };
  usedBytes: number;
}

export interface Vault {
  id: string;
  user_id: string;
  type: "user_vault" | "share_vault";
  name: string;
  created_at: string;
  used_bytes?: string | number;
}

export interface VaultItem {
  id: string;
  vault_id: string;
  parent_path: string;
  path: string;
  name: string;
  item_type: "file" | "folder";
  mime_type?: string | null;
  size_bytes: string | number;
  created_at: string;
  updated_at: string;
  owner_email?: string;
}

const TOKEN_KEY = "torrent-shred-vault-token";

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (!headers.has("content-type") && init.body && !(init.body instanceof Blob) && !(init.body instanceof ArrayBuffer)) {
    headers.set("content-type", "application/json");
  }
  if (token) headers.set("authorization", `Bearer ${token}`);

  const response = await fetch(path, { ...init, headers });
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json") ? await response.json() : await response.text();

  if (!response.ok) {
    const message = typeof body === "object" && body && "error" in body ? String((body as { error: unknown }).error) : response.statusText;
    throw new Error(message);
  }

  return body as T;
}

export const api = {
  login: (email: string, password: string) =>
    request<{ token: string; user: ApiUser }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  register: (email: string, password: string) =>
    request<{ token: string; user: ApiUser }>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: boolean }>("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  me: () => request<{ user: ApiUser; quota: VaultQuota }>("/api/me"),
  vaults: () => request<{ vaults: Vault[]; quota: VaultQuota }>("/api/vaults"),
  listFiles: (vaultId: string, path = "/") =>
    request<{ vault: Vault; path: string; items: VaultItem[] }>(`/api/files?vaultId=${encodeURIComponent(vaultId)}&path=${encodeURIComponent(path)}`),
  createFolder: (vaultId: string, path: string, name: string) =>
    request<{ item: VaultItem }>("/api/files/folder", {
      method: "POST",
      body: JSON.stringify({ vaultId, path, name }),
    }),
  uploadFile: (vaultId: string, path: string, password: string, file: File) =>
    request<{ item: VaultItem; quota: VaultQuota }>(`/api/files/upload?vaultId=${encodeURIComponent(vaultId)}&path=${encodeURIComponent(path)}`, {
      method: "POST",
      headers: {
        "x-vault-password": password,
        "x-file-name": encodeURIComponent(file.name),
        "content-type": file.type || "application/octet-stream",
      },
      body: file,
    }),
  downloadFile: async (item: VaultItem, password: string) => {
    const token = getToken();
    const response = await fetch(`/api/files/${item.id}/download`, {
      headers: {
        authorization: `Bearer ${token}`,
        "x-vault-password": password,
      },
    });
    if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? "Download failed");
    return response.blob();
  },
  deleteFile: (id: string) => request<{ ok: boolean; deleted: number }>(`/api/files/${id}`, { method: "DELETE" }),
  sharedFiles: (path = "/") => request<{ path: string; items: VaultItem[] }>(`/api/share/files?path=${encodeURIComponent(path)}`),
  downloadSharedFile: async (item: VaultItem) => {
    const token = getToken();
    const response = await fetch(`/api/share/files/${item.id}/download`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? "Shared download failed");
    return response.blob();
  },
  clientConfig: () => request<unknown>("/api/client/config"),
  clientDownloads: () => request<{ downloads: Array<{ platform: string; status: string; label: string; url: string | null }> }>("/api/client/downloads"),
  adminUsers: () =>
    request<{ users: Array<ApiUser & { used_bytes: string | number; user_quota_bytes: string | number }> }>("/api/admin/users"),
  adminResetUserPassword: (userId: string, newPassword: string) =>
    request<{ ok: boolean }>(`/api/admin/users/${encodeURIComponent(userId)}/reset-password`, {
      method: "POST",
      body: JSON.stringify({ newPassword }),
    }),
  updateCheck: () => request<UpdateCheck>("/api/admin/system/update/check"),
  updateApply: () => request<UpdateStatus>("/api/admin/system/update/apply", { method: "POST" }),
  updateStatus: () => request<{ updater: UpdateStatus; history: UpdateHistory[] }>("/api/admin/system/update/status"),
};

export interface UpdateCheck {
  repoUrl: string;
  branch: string;
  localSha: string;
  remoteSha: string;
  hasUpdate: boolean;
}

export interface UpdateStatus extends Partial<UpdateCheck> {
  status: string;
  message?: string;
  logs?: string;
  updatedAt?: string;
  error?: string;
}

export interface UpdateHistory {
  id: string;
  status: string;
  local_sha?: string;
  remote_sha?: string;
  message?: string;
  logs?: string;
  created_at: string;
}

export function formatBytes(value: string | number | undefined) {
  const bytes = Number(value ?? 0);
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
