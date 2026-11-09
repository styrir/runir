export class ExtractionFailure extends Error {
  constructor() {
    super("capture extraction failed");
    this.name = "ExtractionFailure";
  }
}
