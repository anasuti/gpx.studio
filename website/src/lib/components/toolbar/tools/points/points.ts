import { writable } from 'svelte/store';

/**
 * Index in the selection of the trackpoint that the points tool has selected, where the buttons
 * of the tool act. It is `null` when no point is selected.
 */
export const selectedPoint = writable<number | null>(null);

/**
 * Whether a point can be added after the selected one: not when it is the last point of a segment
 * that is followed by another one, since it would go to the next segment.
 */
export const canInsertAfter = writable(false);
