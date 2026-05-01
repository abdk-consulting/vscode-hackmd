import { HackMdApiClient } from '../hackmdApiClient';
import { HackmdModel } from './hackmdModel';

let modelSingleton: HackmdModel | undefined;
let modelApiInstance: HackMdApiClient | undefined;

export function initializeHackmdModel(api: HackMdApiClient): HackmdModel {
  if (!modelSingleton || modelApiInstance !== api) {
    modelSingleton = new HackmdModel(api);
    modelApiInstance = api;
  }
  return modelSingleton;
}

export function getHackmdModel(): HackmdModel {
  if (!modelSingleton) {
    throw new Error('HackmdModel is not initialized. Call initializeHackmdModel(api) first.');
  }
  return modelSingleton;
}

export function resetHackmdModelForTests(): void {
  modelSingleton = undefined;
  modelApiInstance = undefined;
}

export * from './hackmdModel';
