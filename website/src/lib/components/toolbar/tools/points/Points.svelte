<script lang="ts">
    import { Button } from '$lib/components/ui/button';
    import Help from '$lib/components/Help.svelte';
    import { i18n } from '$lib/i18n/i18n.svelte';
    import { onDestroy, onMount } from 'svelte';
    import { get } from 'svelte/store';
    import { getURLForLanguage } from '$lib/utils';
    import { Plus, Trash2 } from '@lucide/svelte';
    import { map } from '$lib/components/map/map';
    import { mapCursor, MapCursorState } from '$lib/state/map-cursor';
    import { engine } from '$lib/engine';
    import { coversSegments } from '$lib/engine/selection-helpers';
    import { PointControls } from './points-controls';
    import { canInsertAfter, selectedPoint } from './points';

    let props: {
        class?: string;
    } = $props();

    const selection = engine.selection;
    let validSelection = $derived(coversSegments($selection));

    let pointControls: PointControls | undefined = undefined;

    function onKeyDown(e: KeyboardEvent) {
        if (e.key !== 'Delete' && e.key !== 'Backspace') {
            return;
        }
        if (e.metaKey || e.ctrlKey || e.altKey) {
            // the shortcuts that combine the key with a modifier do something else
            return;
        }
        const target = e.target as HTMLElement | null;
        if (
            target &&
            (target.tagName === 'INPUT' ||
                target.tagName === 'TEXTAREA' ||
                target.isContentEditable)
        ) {
            return;
        }
        if (get(selectedPoint) === null) {
            return;
        }
        e.preventDefault();
        pointControls?.deleteSelected();
    }

    onMount(() => {
        pointControls = new PointControls();
        if ($map) {
            mapCursor.notify(MapCursorState.TOOL_WITH_CROSSHAIR, true);
        }
        window.addEventListener('keydown', onKeyDown);
    });

    onDestroy(() => {
        pointControls?.destroy();
        pointControls = undefined;
        mapCursor.notify(MapCursorState.TOOL_WITH_CROSSHAIR, false);
        window.removeEventListener('keydown', onKeyDown);
    });
</script>

<div class="flex flex-col gap-3 w-full max-w-80 {props.class ?? ''}">
    <div class="flex flex-row gap-1">
        <Button
            variant="outline"
            class="grow"
            disabled={!validSelection || $selectedPoint === null}
            onclick={() => pointControls?.deleteSelected()}
        >
            <Trash2 size="16" />
            {i18n._('toolbar.points.delete')}
        </Button>
        <Button
            variant="outline"
            class="grow"
            disabled={!validSelection || !$canInsertAfter}
            onclick={() => pointControls?.insertAfter()}
        >
            <Plus size="16" />
            {i18n._('toolbar.points.insert_after')}
        </Button>
    </div>
    <Help link={getURLForLanguage(i18n.lang, '/help/toolbar/routing')}>
        {#if validSelection}
            {i18n._('toolbar.points.help')}
        {:else}
            {i18n._('toolbar.points.help_no_selection')}
        {/if}
    </Help>
</div>
