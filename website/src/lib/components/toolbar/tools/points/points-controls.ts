import { get } from 'svelte/store';
import {
    type GeoJSONSource,
    type MapLayerMouseEvent,
    type MapLayerTouchEvent,
    Point,
} from 'maplibre-gl';
import { mapCursor, MapCursorState } from '$lib/state/map-cursor';
import { currentTool, Tool } from '$lib/components/toolbar/tools';
import { map } from '$lib/components/map/map';
import { ANCHOR_LAYER_KEY } from '$lib/components/map/style';
import { projectOnPolyline } from '$lib/geo/closest-point';
import { coversSegments } from '$lib/engine/selection-helpers';
import {
    engine,
    type Selection,
    type SelectionSegments,
    type SelectionStatistics,
    type StatisticsRequest,
} from '$lib/engine';
import { selectedPoint, canInsertAfter } from './points';

/** The source and layer of the points. */
const LAYER_ID = 'points-controls';

/** Under this zoom level, only the selected trackpoint is shown, to keep the map readable. */
const POINT_MIN_ZOOM = 14;

/** Distance in pixels under which a click on the line selects the closest point instead of adding one. */
const SNAP_DISTANCE = 8;

/** A trackpoint of the selection, shown on the map as a dot that can be selected, dragged or deleted. */
type Trackpoint = {
    index: number;
    lng: number;
    lat: number;
};

type PointProperties = { index: number; minZoom: number; selected: boolean };
type PointFeature = GeoJSON.Feature<GeoJSON.Point, PointProperties>;

/**
 * The trackpoints of the selection of the engine, shown as dots that the user can select, drag to
 * move, shift-click to delete, and add by clicking on the line of the selection. Every interaction
 * is turned into a command of the engine, which finds the files and segments by the indices of the
 * trackpoints in the selection.
 */
export class PointControls {
    active = false;
    statistics: SelectionStatistics | undefined = undefined;
    /** What the tool needs from the engine, while it shows the points. */
    request: StatisticsRequest = engine.requestStatistics();
    selection: Selection = { type: 'empty' };
    segments: SelectionSegments | undefined = undefined;
    /** Ids of the files whose line layer is listened to. */
    listenedFileIds: string[] = [];
    unsubscribes: (() => void)[] = [];

    updateBinded: () => void = this.update.bind(this);
    insertPointBinded: (e: MapLayerMouseEvent) => void = this.insertPoint.bind(this);

    /** Index in the selection of the trackpoint that is dragged. */
    draggedIndex: number | null = null;
    lastDraggedEventTime = 0;
    draggingStartingPosition: Point = new Point(0, 0);
    draggingStartCoordinates: { lng: number; lat: number } | null = null;

    onMouseEnterBinded: () => void = this.onMouseEnter.bind(this);
    onMouseLeaveBinded: () => void = this.onMouseLeave.bind(this);
    onClickBinded: (e: MapLayerMouseEvent) => void = this.onClick.bind(this);
    onMouseDownBinded: (e: MapLayerMouseEvent) => void = this.onMouseDown.bind(this);
    onTouchStartBinded: (e: MapLayerTouchEvent) => void = this.onTouchStart.bind(this);
    onMouseMoveBinded: (e: MapLayerMouseEvent | MapLayerTouchEvent) => void =
        this.onMouseMove.bind(this);
    onMouseUpBinded: (e: MapLayerMouseEvent | MapLayerTouchEvent) => void =
        this.onMouseUp.bind(this);

    constructor() {
        this.unsubscribes.push(engine.selection.subscribe(this.onSelection.bind(this)));
        this.unsubscribes.push(currentTool.subscribe(this.updateBinded));
        this.unsubscribes.push(engine.statistics.subscribe(this.onStatistics.bind(this)));
        this.unsubscribes.push(engine.files.subscribe(this.updateFileListeners.bind(this)));
        this.unsubscribes.push(selectedPoint.subscribe(this.updateControls.bind(this)));
    }

    onSelection(selection: Selection) {
        this.selection = selection;
        // the index of the selected point means nothing in another selection
        selectedPoint.set(null);
        this.update();
    }

    onStatistics(statistics: SelectionStatistics) {
        this.statistics = statistics;
        this.segments = statistics.segments;
        const selected = get(selectedPoint);
        if (selected !== null && selected >= statistics.length) {
            // the point is gone: the last one becomes selected
            selectedPoint.set(statistics.length > 0 ? statistics.length - 1 : null);
            return;
        }
        this.updateControls();
    }

    update() {
        const points = get(currentTool) === Tool.POINTS && coversSegments(this.selection);
        this.request.set(points ? ['segments'] : []);
        if (!points) {
            if (this.active) {
                this.remove();
            }
            return;
        }
        if (!this.active) {
            this.add();
        }
        this.updateControls();
    }

    add() {
        const map_ = get(map);
        if (!map_) {
            return;
        }

        this.active = true;
        map_.on('style.load', this.updateBinded);
        this.updateFileListeners();
    }

    /** Listens to the lines of the files, to add points where the pointer clicks a segment. */
    updateFileListeners() {
        const layerEventManager = map.layerEventManager;
        if (!layerEventManager) {
            return;
        }
        const fileIds = this.active ? [...get(engine.files).keys()] : [];
        for (const fileId of this.listenedFileIds) {
            if (!fileIds.includes(fileId)) {
                layerEventManager.off('click', fileId, this.insertPointBinded);
            }
        }
        for (const fileId of fileIds) {
            if (!this.listenedFileIds.includes(fileId)) {
                layerEventManager.on('click', fileId, this.insertPointBinded);
            }
        }
        this.listenedFileIds = fileIds;
    }

    /** Whether the selected point can get a new point after it. */
    updateInsertAfter() {
        const statistics = this.statistics;
        const index = get(selectedPoint);
        if (!statistics || index === null) {
            canInsertAfter.set(false);
            return;
        }
        const [, end] = this.segmentRange(this.segmentOf(index));
        canInsertAfter.set(index + 1 < end || (index + 1 === end && end === statistics.length));
    }

    /** First trackpoint of a segment of the selection, and the one after its last one. */
    segmentRange(segment: number): [number, number] {
        const starts = this.segments?.starts;
        const length = this.statistics?.length ?? 0;
        if (!starts || segment < 0 || segment >= starts.length) {
            return [0, 0];
        }
        return [starts[segment], segment + 1 < starts.length ? starts[segment + 1] : length];
    }

    /** Position among the segments of the selection of the one that holds the trackpoint. */
    segmentOf(index: number): number {
        const starts = this.segments?.starts;
        if (!starts || starts.length === 0) {
            return -1;
        }
        let segment = 0;
        for (let i = 1; i < starts.length; i++) {
            if (starts[i] > index) {
                break;
            }
            segment = i;
        }
        return segment;
    }

    /** The points of the selection, from the statistics of the engine. */
    readPoints(): Trackpoint[] {
        const statistics = this.statistics;
        if (!statistics) {
            return [];
        }
        const points: Trackpoint[] = [];
        for (let index = 0; index < statistics.length; index++) {
            points.push({
                index,
                lng: statistics.lng[index],
                lat: statistics.lat[index],
            });
        }
        return points;
    }

    updateControls() {
        this.updateInsertAfter();

        const map_ = get(map);
        const layerEventManager = map.layerEventManager;
        if (!map_ || !layerEventManager || !this.active) {
            return;
        }

        const selected = get(selectedPoint);
        const features: PointFeature[] = this.readPoints().map((point) => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [point.lng, point.lat] },
            properties: {
                index: point.index,
                // the selected point stays visible at every zoom level
                minZoom: point.index === selected ? 0 : POINT_MIN_ZOOM,
                selected: point.index === selected,
            },
        }));

        try {
            const source = map_.getSource(LAYER_ID) as GeoJSONSource | undefined;
            const data: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features };
            if (source) {
                source.setData(data);
            } else {
                map_.addSource(LAYER_ID, { type: 'geojson', data, promoteId: 'index' });
            }

            if (!map_.getLayer(LAYER_ID)) {
                // bigger on small screens, to be touched
                const scale = window.innerWidth > 1000 ? 0.7 : 1;
                map_.addLayer(
                    {
                        id: LAYER_ID,
                        type: 'circle',
                        source: LAYER_ID,
                        paint: {
                            'circle-radius': 4.5 * scale,
                            'circle-color': ['case', ['get', 'selected'], '#2563eb', 'white'],
                            'circle-stroke-width': 1.5 * scale,
                            'circle-stroke-color': [
                                'case',
                                ['get', 'selected'],
                                '#1e3a8a',
                                'black',
                            ],
                        },
                        filter: ['>=', ['zoom'], ['get', 'minZoom']],
                    },
                    ANCHOR_LAYER_KEY.pointsControls
                );

                layerEventManager.on('mouseenter', LAYER_ID, this.onMouseEnterBinded);
                layerEventManager.on('mouseleave', LAYER_ID, this.onMouseLeaveBinded);
                layerEventManager.on('click', LAYER_ID, this.onClickBinded);
                layerEventManager.on('mousedown', LAYER_ID, this.onMouseDownBinded);
                layerEventManager.on('touchstart', LAYER_ID, this.onTouchStartBinded);
            }
        } catch {
            // No reliable way to check if the map is ready to add sources and layers
        }
    }

    remove() {
        const map_ = get(map);
        const layerEventManager = map.layerEventManager;

        this.active = false;

        map_?.off('style.load', this.updateBinded);
        this.updateFileListeners();

        try {
            layerEventManager?.off('mouseenter', LAYER_ID, this.onMouseEnterBinded);
            layerEventManager?.off('mouseleave', LAYER_ID, this.onMouseLeaveBinded);
            layerEventManager?.off('click', LAYER_ID, this.onClickBinded);
            layerEventManager?.off('mousedown', LAYER_ID, this.onMouseDownBinded);
            layerEventManager?.off('touchstart', LAYER_ID, this.onTouchStartBinded);

            if (map_?.getLayer(LAYER_ID)) {
                map_?.removeLayer(LAYER_ID);
            }

            if (map_?.getSource(LAYER_ID)) {
                map_?.removeSource(LAYER_ID);
            }
        } catch {
            // No reliable way to check if the map is ready to remove sources and layers
        }

        selectedPoint.set(null);
    }

    position(index: number) {
        const statistics = this.statistics;
        return statistics
            ? { lng: statistics.lng[index], lat: statistics.lat[index] }
            : { lng: 0, lat: 0 };
    }

    /**
     * Adds a point where the user clicks the line of a segment of the selection, with an elevation
     * in between the ones of its neighbours, and selects it. A click on a point selects it.
     */
    async insertPoint(e: MapLayerMouseEvent) {
        if (this.draggedIndex !== null || Date.now() - this.lastDraggedEventTime < 100) {
            return;
        }
        const map_ = get(map);
        const statistics = this.statistics;
        const segments = this.segments;
        if (!map_ || !statistics || !segments) {
            return;
        }
        if (map_.queryRenderedFeatures(e.point, { layers: [LAYER_ID] }).length > 0) {
            // clicked on a point, which selects it
            return;
        }

        const segment = segments.ids.indexOf(e.features![0].properties!.segmentId);
        if (segment < 0) {
            return;
        }
        const [start, end] = this.segmentRange(segment);
        if (end - start < 2) {
            return;
        }

        const projection = projectOnPolyline(
            statistics.lng,
            statistics.lat,
            start,
            end - 1,
            e.lngLat
        );
        if (!projection) {
            return;
        }

        const projected = map_.project([projection.lng, projection.lat]);
        if (projected.dist(e.point) < SNAP_DISTANCE) {
            // the point is on an existing trackpoint, which is selected instead of copied
            const index = projection.ratio <= 0.5 ? projection.index - 1 : projection.index;
            selectedPoint.set(Math.max(start, Math.min(end - 1, index)));
            return;
        }

        const before = projection.index - 1;
        const after = projection.index;
        const ele =
            statistics.ele[before] +
            projection.ratio * (statistics.ele[after] - statistics.ele[before]);
        const changed = await engine.insertTrackpoint(
            segments.revision,
            projection.index,
            projection.lng,
            projection.lat,
            Number.isFinite(ele) ? ele : statistics.ele[before]
        );
        if (changed) {
            selectedPoint.set(projection.index);
        }
    }

    /** Adds a point after the selected one, halfway to the next one, and selects it. */
    async insertAfter() {
        const statistics = this.statistics;
        const segments = this.segments;
        const index = get(selectedPoint);
        if (!statistics || !segments || index === null) {
            return;
        }

        const segment = this.segmentOf(index);
        if (segment < 0) {
            return;
        }
        const [start, end] = this.segmentRange(segment);
        const insertAt = index + 1;

        let coordinates: { lng: number; lat: number; ele: number };
        if (insertAt < end) {
            // halfway to the next point of the same segment
            coordinates = {
                lng: (statistics.lng[index] + statistics.lng[insertAt]) / 2,
                lat: (statistics.lat[index] + statistics.lat[insertAt]) / 2,
                ele: (statistics.ele[index] + statistics.ele[insertAt]) / 2,
            };
        } else if (end === statistics.length) {
            // after the last point: in the direction of the segment when it has one
            const before = index > start ? index - 1 : null;
            const delta = (value: ArrayLike<number>) =>
                before === null ? 0.0001 : value[index] - value[before];
            coordinates = {
                lng: statistics.lng[index] + delta(statistics.lng),
                lat: statistics.lat[index] + delta(statistics.lat),
                ele: statistics.ele[index] + (before === null ? 0 : delta(statistics.ele)),
            };
        } else {
            // the next point belongs to another segment
            return;
        }

        const changed = await engine.insertTrackpoint(
            segments.revision,
            insertAt,
            coordinates.lng,
            coordinates.lat,
            coordinates.ele
        );
        if (changed) {
            selectedPoint.set(insertAt);
        }
    }

    /** Deletes the selected point. */
    deleteSelected() {
        this.deletePoint(get(selectedPoint));
    }

    /** Deletes a point, and keeps the point after it selected when it was the selected one. */
    async deletePoint(index: number | null) {
        const revision = this.segments?.revision;
        if (index === null || revision === undefined) {
            return;
        }
        const changed = await engine.deleteTrackpoint(revision, index);
        if (!changed) {
            return;
        }
        const selected = get(selectedPoint);
        if (selected !== null && selected > index) {
            // the points after the deleted one moved back by one
            selectedPoint.set(selected - 1);
        }
    }

    onMouseEnter() {
        mapCursor.notify(MapCursorState.ANCHOR_HOVER, true);
    }

    onMouseLeave() {
        if (this.draggedIndex === null) {
            mapCursor.notify(MapCursorState.ANCHOR_HOVER, false);
        }
    }

    onClick(e: MapLayerMouseEvent) {
        e.preventDefault();

        if (this.draggedIndex !== null || Date.now() - this.lastDraggedEventTime < 100) {
            return;
        }

        const index: number | undefined = e.features![0].properties!.index;
        if (index === undefined) {
            return;
        }
        if (e.originalEvent.shiftKey) {
            this.deletePoint(index);
        } else {
            selectedPoint.set(index);
        }
    }

    onMouseDown(e: MapLayerMouseEvent) {
        const map_ = get(map);
        if (!map_) {
            return;
        }

        e.preventDefault();
        map_.dragPan.disable();

        this.draggedIndex = e.features![0].properties!.index;
        this.draggingStartingPosition = e.point;
        this.draggingStartCoordinates = this.position(this.draggedIndex!);

        map_.on('mousemove', this.onMouseMoveBinded);
        map_.once('mouseup', this.onMouseUpBinded);
    }

    onTouchStart(e: MapLayerTouchEvent) {
        if (e.points.length !== 1) {
            return;
        }
        const map_ = get(map);
        if (!map_) {
            return;
        }

        this.draggedIndex = e.features![0].properties!.index;
        this.draggingStartingPosition = e.point;
        this.draggingStartCoordinates = this.position(this.draggedIndex!);

        e.preventDefault();
        map_.dragPan.disable();

        map_.on('touchmove', this.onMouseMoveBinded);
        map_.once('touchend', this.onMouseUpBinded);
    }

    onMouseMove(e: MapLayerMouseEvent | MapLayerTouchEvent) {
        if (this.draggedIndex === null || e.point.equals(this.draggingStartingPosition)) {
            return;
        }

        mapCursor.notify(MapCursorState.ANCHOR_DRAGGING, true);
        this.movePointFeature(this.draggedIndex, {
            lng: e.lngLat.lng,
            lat: e.lngLat.lat,
        });
        this.lastDraggedEventTime = Date.now();
    }

    async onMouseUp(e: MapLayerMouseEvent | MapLayerTouchEvent) {
        mapCursor.notify(MapCursorState.ANCHOR_DRAGGING, false);

        const map_ = get(map);
        if (!map_) {
            return;
        }

        map_.dragPan.enable();
        map_.off('mousemove', this.onMouseMoveBinded);
        map_.off('touchmove', this.onMouseMoveBinded);

        const index = this.draggedIndex;
        const start = this.draggingStartCoordinates;
        this.draggedIndex = null;
        this.draggingStartCoordinates = null;
        if (index === null) {
            return;
        }
        if (e.point.equals(this.draggingStartingPosition)) {
            return;
        }

        this.lastDraggedEventTime = Date.now();
        const revision = this.segments?.revision;
        if (revision === undefined) {
            if (start) {
                this.movePointFeature(index, start);
            }
            return;
        }

        const changed = await engine.moveTrackpoint(revision, index, e.lngLat.lng, e.lngLat.lat);
        if (!changed && start) {
            // the engine kept the point where it was
            this.movePointFeature(index, start);
        }
        selectedPoint.set(index);
    }

    movePointFeature(index: number, coordinates: { lng: number; lat: number }) {
        const source = get(map)?.getSource(LAYER_ID) as GeoJSONSource | undefined;
        if (source) {
            source.updateData({
                update: [
                    {
                        id: index,
                        newGeometry: {
                            type: 'Point',
                            coordinates: [coordinates.lng, coordinates.lat],
                        },
                    },
                ],
            });
        }
    }

    destroy() {
        this.remove();
        this.request.release();
        this.unsubscribes.forEach((unsubscribe) => unsubscribe());
    }
}
