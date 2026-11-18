use std::{collections::HashSet, rc::Rc};

use crate::{Apply, CommandError, State};

use super::route::find_target;

/// Deletes the trackpoint `index` of the selection. A segment left without trackpoints is
/// removed, with its route or its track when they have nothing left.
#[derive(Debug)]
pub struct DeleteTrackpoint {
    pub index: u32,
}

impl Apply for DeleteTrackpoint {
    fn apply(self, state: &mut State) -> Result<(), CommandError> {
        let index = self.index as usize;
        let target = find_target(state, index, index + 1)?.ok_or(CommandError::NothingToDo)?;
        let mut file = (*state.files[&target.location.file_id]).clone();
        let segment = file.segment_mut(target.location.index);
        if target.start >= segment.len() {
            return Err(CommandError::NothingToDo);
        }
        let segment_id = segment.id;
        segment.splice(target.start, target.start + 1, vec![]);
        let emptied = segment.is_empty();
        state.files.insert(target.location.file_id, Rc::new(file));

        if emptied {
            super::clean::prune(state, &HashSet::from([segment_id]), &HashSet::new());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use crate::{
        File, FileId, Load, Selection, Track, TrackSegment, Trackpoint, TrackpointChunk,
        engine::command::fixture::Fixture,
    };

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

    fn count(fx: &Fixture, id: FileId) -> usize {
        fx.files[&id]
            .trk
            .iter()
            .flat_map(|trk| &trk.trkseg)
            .map(|seg| seg.len())
            .sum()
    }

    #[test]
    fn test_only_the_point_is_removed_and_the_selection_is_kept() {
        let (mut fx, id) = loaded("data/with_tracks_and_segments.gpx");
        let before = count(&fx, id);
        let selection = fx.selection.clone();
        let rev = fx.files[&id].trk[0].trkseg[0].rev_id;

        DeleteTrackpoint { index: 1 }
            .apply(&mut fx.state())
            .unwrap();

        assert_eq!(count(&fx, id), before - 1);
        assert_ne!(fx.files[&id].trk[0].trkseg[0].rev_id, rev);
        assert_eq!(fx.selection, selection);
    }

    #[test]
    fn test_a_segment_left_empty_is_removed() {
        let mut fx = Fixture::default();
        let mut segment = TrackSegment::default();
        segment.push(TrackpointChunk {
            trkpt: vec![Trackpoint::default()],
            ..Default::default()
        });
        let mut track = Track::default();
        track.trkseg.push(segment);
        let mut file = File::default();
        file.trk.push(track);
        let id = file.id;
        fx.files.insert(id, Rc::new(file));
        fx.order.0.push(id);
        fx.selection = Selection::File {
            file_ids: HashSet::from([id]),
        };

        DeleteTrackpoint { index: 0 }
            .apply(&mut fx.state())
            .unwrap();

        assert!(fx.files[&id].trk.is_empty());
        assert_eq!(
            fx.selection,
            Selection::File {
                file_ids: HashSet::from([id])
            }
        );
    }

    #[test]
    fn test_an_index_out_of_the_selection_is_nothing_to_do() {
        let (mut fx, id) = loaded("data/with_tracks_and_segments.gpx");
        let before = fx.files[&id].clone();
        let length = count(&fx, id);

        let result = DeleteTrackpoint {
            index: length as u32,
        }
        .apply(&mut fx.state());
        assert!(matches!(
            result,
            Err(CommandError::NothingToDo) | Err(CommandError::InvalidData(_))
        ));
        assert!(Rc::ptr_eq(&fx.files[&id], &before));
    }
}
