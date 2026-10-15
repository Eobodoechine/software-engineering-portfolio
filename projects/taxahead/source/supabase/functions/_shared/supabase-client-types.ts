// Minimal structural types for the Supabase client used by edge functions.
// Edge functions are not type-checked by the root tsconfig; these types keep
// the lint gate (no-explicit-any) clean without importing the generated
// database types into every module. They are deliberately loose (unknown
// payloads) because edge modules fetch rows without generated row types;
// modules that need typed rows cast at their own boundary.

export type PostgrestError = { message: string; code?: string };

export type ResultRow = Record<string, unknown>;

export type FromResult<T = unknown> = {
  data: T | null;
  error: PostgrestError | null;
};

export type RpcResult<T = unknown> = {
  data: T;
  error: PostgrestError | null;
};

export type QueryBuilderLike = {
  select: (columns?: string) => QueryBuilderLike;
  eq: (column: string, value: unknown) => QueryBuilderLike;
  neq: (column: string, value: unknown) => QueryBuilderLike;
  is: (column: string, value: unknown) => QueryBuilderLike;
  gt: (column: string, value: unknown) => QueryBuilderLike;
  lt: (column: string, value: unknown) => QueryBuilderLike;
  in: (column: string, values: unknown[]) => QueryBuilderLike;
  order: (
    column: string,
    opts?: {
      ascending?: boolean;
      nullsFirst?: boolean;
      foreignTable?: string;
      referencedTable?: string;
    },
  ) => QueryBuilderLike;
  limit: (n: number) => QueryBuilderLike;
  insert: (payload: Record<string, unknown>) => QueryBuilderLike;
  update: (payload: Record<string, unknown>) => QueryBuilderLike;
  upsert: (payload: Record<string, unknown>, opts?: Record<string, unknown>) => QueryBuilderLike;
  delete: () => QueryBuilderLike;
  single: () => PromiseLike<FromResult<ResultRow>>;
  maybeSingle: () => PromiseLike<FromResult<ResultRow | null>>;
  then: <TResult1 = FromResult<ResultRow[]>, TResult2 = never>(
    onfulfilled?: ((value: FromResult<ResultRow[]>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) => PromiseLike<TResult1 | TResult2>;
};

export type StorageBucketLike = {
  from: (bucket: string) => {
    upload: (path: string, file: unknown, opts?: Record<string, unknown>) => Promise<FromResult>;
    download: (path: string) => Promise<FromResult<Blob>>;
    remove: (paths: string[]) => Promise<FromResult>;
    createSignedUploadUrl: (path: string) => Promise<FromResult>;
  };
};

export type FunctionsLike = {
  invoke: (name: string, opts: { body: unknown }) => Promise<{ data: unknown; error: unknown }>;
};

export type SupabaseLike = {
  rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<RpcResult> | Promise<RpcResult>;
  from: (table: string) => QueryBuilderLike;
  storage: StorageBucketLike;
  functions: FunctionsLike;
  auth: {
    getUser: () => Promise<{ data: { user: unknown }; error: unknown }>;
  };
};
