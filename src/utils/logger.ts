// Logger utility for FLST Chrome extension

export class Logger {
  private static instance: Logger;
  private isEnabled: boolean = false; // Disabled for production

  private constructor() {}

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  public setEnabled(enabled: boolean): void {
    this.isEnabled = enabled;
  }

  public isLoggingEnabled(): boolean {
    return this.isEnabled;
  }

  public log(message: string): void {
    if (this.isEnabled) {
      console.log(`[FLST] ${message}`);
    }
  }

  public error(message: string, error?: any): void {
    console.error(`[FLST ERROR] ${message}`, error);
  }

  public warn(message: string): void {
    console.warn(`[FLST WARN] ${message}`);
  }

  public debug(message: string): void {
    if (this.isEnabled) {
      console.log(`[FLST DEBUG] ${message}`);
    }
  }
}

// Export singleton instance
export const logger = Logger.getInstance();
