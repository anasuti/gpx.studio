use std::rc::Rc;

use crate::{Apply, CommandError, LngLat, State};

use super::route::find_target;

/// Moves the trackpoint `index` of the selection to the given coordinates, keeping its elevation,
/// time and other data: what dragging it on the map does, without rerouting the segment.
#[derive(Debug)]
pub struct MoveTrackpoint {
    pub index: u32,
    pub lng: f64,
    pub lat: f64,
}

impl Apply for MoveTrackpoint {
    fn apply(self, state: &mut State) -> Result<(), CommandError> {
        let index = self.index as usize;
        let target = find_target(state, index, index + 1)?.ok_or(CommandError::NothingToDo)?;
        let mut file = (*state.files[&target.location.file_id]).clone();
        let segment = file.segment_mut(target.location.index);
        if target.start >= segment.len() {
            return Err(CommandError::NothingToDo);
        }
        segment.update(target.start, |trkpt| {
            trkpt.coordinates = LngLat {
                lng: self.lng,
                lat: self.lat,
            };
        });
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
    fn test_only_the_point_moves_and_keeps_its_data() {
        let (mut fx, id) = loaded("data/with_time.gpx");
        let before = first_segment(&fx, id);
        let point = &before[10];
        let time = point.time;
        let ele = point.ele;
        let selection = fx.selection.clone();

        MoveTrackpoint {
            index: 10,
            lng: 4.5,
            lat: 50.5,
        }
        .apply(&mut fx.state())
        .unwrap();

        let after = first_segment(&fx, id);
        assert_eq!(after.len(), before.len());
        assert_eq!((after[10].coordinates.lng, after[10].coordinates.lat), (4.5, 50.5));
        assert_eq!(after[10].time, time);
        assert_eq!(after[10].ele, ele);
        assert_ne!(after.rev_id, before.rev_id);
        assert_eq!(fx.selection, selection);
        // the other points are untouched
        assert_eq!(after[9].coordinates.lng, before[9].coordinates.lng);
        assert_eq!(after[11].time, before[11].time);
    }

    #[test]
    fn test_an_index_out_of_the_selection_is_nothing_to_do() {
        let (mut fx, id) = loaded("data/with_time.gpx");
        let before = fx.files[&id].clone();
        let length = first_segment(&fx, id).len();

        for index in [length as u32, length as u32 + 10] {
            let result = MoveTrackpoint {
                index,
                lng: 4.5,
                lat: 50.5,
            }
            .apply(&mut fx.state());
            assert!(matches!(
                result,
                Err(CommandError::NothingToDo) | Err(CommandError::InvalidData(_))
            ));
        }
        assert!(Rc::ptr_eq(&fx.files[&id], &before));
    }
}
