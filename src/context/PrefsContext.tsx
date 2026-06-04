import { createContext, useContext } from 'react';
import type { Prefs } from '../types';
import { DEFAULT_PREFS } from '../types';

export const PrefsContext = createContext<Prefs>(DEFAULT_PREFS);

export function usePrefs(): Prefs {
  return useContext(PrefsContext);
}
