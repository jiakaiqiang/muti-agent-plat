export type ApiResponse<T> = {
  data: T;
  requestId: string;
};

export type ApiError = {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  requestId: string;
};

export const ok = <T>(data: T): ApiResponse<T> => ({
  data,
  requestId: crypto.randomUUID()
});
