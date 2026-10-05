import type { LaunchOptions } from 'playwright';
import { BrowserLauncher } from '../capture/index.js';

export class CliBrowserLauncher extends BrowserLauncher {
  override launchOptions(): LaunchOptions {
    return { ...super.launchOptions(), handleSIGINT: false, handleSIGTERM: false };
  }
}
