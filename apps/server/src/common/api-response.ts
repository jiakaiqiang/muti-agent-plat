export type ApiResponse<T> = {
  data: T;
  requestId: string;
};

export const ok = <T>(data: T): ApiResponse<T> => ({
  data,
  requestId: crypto.randomUUID()
});
