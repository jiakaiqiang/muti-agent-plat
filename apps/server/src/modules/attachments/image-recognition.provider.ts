export type ImageContentUnderstandingInput = {
  attachmentId: string;
  fileName: string;
  mimeType: string;
  bytes: Buffer;
  attempt: number;
};

export type ImageContentUnderstandingResult = {
  /** A provider-produced, read-only description. OCR is intentionally out of scope. */
  summary: string;
};

export abstract class ImageContentUnderstandingProvider {
  abstract describe(input: ImageContentUnderstandingInput): Promise<ImageContentUnderstandingResult>;
}

export const GROUP_CHAT_IMAGE_RECOGNITION_PROVIDER = Symbol('GROUP_CHAT_IMAGE_RECOGNITION_PROVIDER');

export class ImageRecognitionUnsupportedError extends Error {
  readonly code = 'image_recognition_unsupported';

  constructor(message = 'No multimodal image understanding provider is configured.') {
    super(message);
    this.name = 'ImageRecognitionUnsupportedError';
  }
}

/**
 * Safe default for installations without a multimodal model. It fails closed:
 * the original image remains available and the UI can offer a retry later.
 */
export class UnsupportedImageContentUnderstandingProvider extends ImageContentUnderstandingProvider {
  async describe(_input: ImageContentUnderstandingInput): Promise<ImageContentUnderstandingResult> {
    throw new ImageRecognitionUnsupportedError();
  }
}

/** Small deterministic provider used by unit tests and local integration checks. */
export class FakeImageContentUnderstandingProvider extends ImageContentUnderstandingProvider {
  constructor(
    private readonly result: ImageContentUnderstandingResult | Error = { summary: 'Fake provider image description.' }
  ) {
    super();
  }

  async describe(_input: ImageContentUnderstandingInput): Promise<ImageContentUnderstandingResult> {
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}
