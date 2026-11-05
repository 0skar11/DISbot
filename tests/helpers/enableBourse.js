// Legacy engine tests explicitly exercise enabled behavior; production defaults remain disabled.
import { botConfig } from '../../src/config/bot.js';
botConfig.features.bourse = true;
