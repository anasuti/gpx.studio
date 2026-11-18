import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { closestPointIndexIn, projectOnPolyline } from '$lib/geo/closest-point';

describe('closestPointIndexIn', () => {
    const lng = [0, 1, 2, 2, 5, 6];
    const lat = [0, 0, 0, 1, 5, 5];

    it('gives the index in the arrays, looking at the given range only', () => {
        assert.equal(closestPointIndexIn(lng, lat, 0, 4, { lng: 0.8, lat: 0.1 }), 1);
        // the range starts after the closest points
        assert.equal(closestPointIndexIn(lng, lat, 4, 6, { lng: 0.8, lat: 0.1 }), 4);
        assert.equal(closestPointIndexIn(lng, lat, 4, 6, { lng: 5.9, lat: 5.1 }), 5);
    });

    it('is the nearest end of the nearest segment', () => {
        assert.equal(closestPointIndexIn(lng, lat, 0, 4, { lng: 0.2, lat: 0.1 }), 0);
        assert.equal(closestPointIndexIn(lng, lat, 0, 4, { lng: 1.6, lat: -0.1 }), 2);
        assert.equal(closestPointIndexIn(lng, lat, 0, 4, { lng: 2.1, lat: 0.9 }), 3);
    });

    it('uses the distance to the segment, not to its ends', () => {
        // far from every point but right next to the long segment
        const [x, y] = [
            [0, 10, 10],
            [0, 0, 5],
        ];
        assert.equal(closestPointIndexIn(x, y, 0, 3, { lng: 7, lat: 0.01 }), 1);
        assert.equal(closestPointIndexIn(x, y, 0, 3, { lng: 3, lat: 0.01 }), 0);
    });

    it('has no point in an empty range', () => {
        assert.equal(closestPointIndexIn(lng, lat, 3, 3, { lng: 0, lat: 0 }), undefined);
        assert.equal(closestPointIndexIn(lng, lat, 4, 2, { lng: 0, lat: 0 }), undefined);
    });

    it('is the point itself for a range of one point', () => {
        assert.equal(closestPointIndexIn(lng, lat, 3, 4, { lng: 9, lat: 9 }), 3);
    });
});

describe('projectOnPolyline', () => {
    const lng = [0, 1, 2, 2, 5, 6];
    const lat = [0, 0, 0, 1, 5, 5];

    it('projects on the closest segment and gives where the point goes', () => {
        const projection = projectOnPolyline(lng, lat, 0, 5, { lng: 1.25, lat: 0.1 });
        assert.ok(projection);
        assert.equal(projection.index, 2);
        assert.ok(Math.abs(projection.ratio - 0.25) < 1e-9);
        assert.ok(Math.abs(projection.lng - 1.25) < 1e-9);
        assert.ok(Math.abs(projection.lat) < 1e-9);
    });

    it('clamps to the ends of the polyline', () => {
        const start = projectOnPolyline(lng, lat, 0, 5, { lng: -1, lat: 1 });
        assert.ok(start);
        assert.equal(start.index, 1);
        assert.equal(start.ratio, 0);
        assert.deepEqual([start.lng, start.lat], [0, 0]);

        const end = projectOnPolyline(lng, lat, 0, 5, { lng: 7, lat: 6 });
        assert.ok(end);
        assert.equal(end.index, 5);
        assert.equal(end.ratio, 1);
        assert.deepEqual([end.lng, end.lat], [6, 5]);
    });

    it('looks at the given range only', () => {
        const projection = projectOnPolyline(lng, lat, 4, 5, { lng: 5.5, lat: 5 });
        assert.ok(projection);
        assert.equal(projection.index, 5);
        assert.ok(Math.abs(projection.ratio - 0.5) < 1e-9);
    });

    it('needs at least two points', () => {
        assert.equal(projectOnPolyline(lng, lat, 3, 3, { lng: 0, lat: 0 }), undefined);
        assert.equal(projectOnPolyline(lng, lat, 4, 2, { lng: 0, lat: 0 }), undefined);
    });
});
