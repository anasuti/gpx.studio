use std::rc::Rc;

use crate::{Apply, CommandError, LngLat, State, Trackpoint, distance};

use super::route::find_target;

/// Inserts a trackpoint at `index` in the selection: the new point is at that index, and the ones
/// from there on are shifted. Its time is interpolated between its neighbours when they have one,
/// and its other data (surface, heart rate...) comes from the closest one. The ends of the
/// segment remain anchors.
#[derive(Debug)]
pub struct InsertTrackpoint {
    pub index: u32,
    pub lng: f64,
    pub lat: f64,
    pub ele: f64,
}

impl Apply for InsertTrackpoint {
    fn apply(self, state: &mut State) -> Result<(), CommandError> {
        if !self.lng.is_finite() || !self.lat.is_finite() || !self.ele.is_finite() {
            return Err(CommandError::InvalidData(
                "the coordinates are not finite".into(),
            ));
        }

        let index = self.index as usize;
        let target = find_target(state, index, index)?.ok_or(CommandError::NothingToDo)?;
        let mut file = (*state.files[&target.location.file_id]).clone();
        let segment = file.segment_mut(target.location.index);
        if target.start > segment.len() {
            return Err(CommandError::NothingToDo);
        }

        let previous = target.start.checked_sub(1).map(|i| segment[i].clone());
        let next = (target.start < segment.len()).then(|| segment[target.start].clone());

        let coordinates = LngLat {
            lng: self.lng,
            lat: self.lat,
        };
        let ratio = match (&previous, &next) {
            (Some(previous), Some(next)) => {
                let length = distance(previous.coordinates, next.coordinates);
                if length > 0.0 {
                    (distance(previous.coordinates, coordinates) / length).clamp(0.0, 1.0)
                } else {
                    0.5
                }
            }
            _ => 0.5,
        };

        let mut point: Trackpoint = previous.clone().or(next.clone()).unwrap_or_default();
        point.coordinates = coordinates;
        point.ele = self.ele;
        point.time = match (&previous, &next) {
            (Some(previous), Some(next)) => previous
                .time
                .zip(next.time)
                .map(|(previous, next)| {
                    ((1.0 - ratio) * previous as f64 + ratio * next as f64) as i64
                }),
            // a point added before the first or after the last one has no time to stand between
            _ => None,
        };
        point.anchor = None;

        let old_len = segment.len();
        segment.splice(target.start, target.start, vec![point]);
        // the point that was an end of the segment is not one anymore, unless it still is
        let moved_end = if old_len == 0 {
            None
        } else if target.start == 0 {
            Some(1)
        } else if target.start == old_len {
            Some(old_len - 1)
        } else {
            None
        };
        if let Some(index) = moved_end {
            if segment[index].anchor == Some(0) {
                segment.update(index, |trkpt| trkpt.anchor = None);
            }
        }
        state.files.insert(target.location.file_id, Rc::new(file));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use crate::{FileId, Load, Selection, engine::command::fixture::Fixture};

    use super::*;

    fn loaded(path: &str) -> (Fixture, FileId) {
        let mut fx = Fixture::default();
        let data = std::fs::read(path).unwrap();
        Load {
            data: &data,
            name: "file",
        }
        .apply(&mut fx.state())
        .unwrap();
        let id = fx.order.0[0];
        fx.selection = Selection::File {
            file_ids: HashSet::from([id]),
        };
        (fx, id)
    }

    fn first_segment(fx: &Fixture, id: FileId) -> crate::TrackSegment {
        fx.files[&id].trk[0].trkseg[0].clone()
    }

    #[test]
    fn test_a_point_is_inserted_between_its_neighbours() {
        let (mut fx, id) = loaded("data/with_time.gpx");
        let before = first_segment(&fx, id);
        let (a, b) = (&before[10], &before[11]);
        let ratio = 0.4;
        let coordinates = LngLat {
            lng: a.coordinates.lng + ratio * (b.coordinates.lng - a.coordinates.lng),
            lat: a.coordinates.lat + ratio * (b.coordinates.lat - a.coordinates.lat),
        };
        let ele = a.ele + ratio * (b.ele - a.ele);

        InsertTrackpoint {
            index: 11,
            lng: coordinates.lng,
            lat: coordinates.lat,
            ele,
        }
        .apply(&mut fx.state())
        .unwrap();

        let after = first_segment(&fx, id);
        assert_eq!(after.len(), before.len() + 1);
        assert_ne!(after.rev_id, before.rev_id);
        assert_eq!(after[10].coordinates.lng, a.coordinates.lng);
        assert_eq!(after[12].coordinates.lng, b.coordinates.lng);
        let point = &after[11];
        assert_eq!((point.coordinates.lng, point.coordinates.lat), (coordinates.lng, coordinates.lat));
        assert_eq!(point.ele, ele);
        // the time follows the position, between the ones of its neighbours
        let time_ratio = (point.time.unwrap() - a.time.unwrap()) as f64
            / (b.time.unwrap() - a.time.unwrap()) as f64;
        assert!((0.3..0.5).contains(&time_ratio), "{time_ratio}");
        assert_eq!(point.anchor, None);
    }

    #[test]
    fn test_appending_a_point_keeps_the_end_an_anchor() {
        let (mut fx, id) = loaded("data/with_time.gpx");
        let before = first_segment(&fx, id);
        let length = before.len();

        InsertTrackpoint {
            index: length as u32,
            lng: 5.0,
            lat: 51.0,
            ele: 10.0,
        }
        .apply(&mut fx.state())
        .unwrap();

        let after = first_segment(&fx, id);
        assert_eq!(after.len(), length + 1);
        assert_eq!(after[length].coordinates.lng, 5.0);
        assert_eq!(after[length].ele, 10.0);
        assert_eq!(after[length].time, None);
        assert_eq!(after[length].anchor, Some(0));
        // the point that was the end of the segment is not an anchor anymore
        assert_eq!(after[length - 1].anchor, None);
    }

    #[test]
    fn test_an_index_out_of_the_selection_is_nothing_to_do() {
        let (mut fx, id) = loaded("data/with_time.gpx");
        let before = fx.files[&id].clone();
        let length = first_segment(&fx, id).len();

        let result = InsertTrackpoint {
            index: length as u32 + 1,
            lng: 5.0,
            lat: 51.0,
            ele: 10.0,
        }
        .apply(&mut fx.state());
        assert!(matches!(
            result,
            Err(CommandError::NothingToDo) | Err(CommandError::InvalidData(_))
        ));
        assert!(Rc::ptr_eq(&fx.files[&id], &before));
    }
}
