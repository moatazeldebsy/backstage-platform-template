import { useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Button,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Typography,
  makeStyles,
  useTheme,
} from '@material-ui/core';
import ArrowForwardIcon from '@material-ui/icons/ArrowForward';
import CloseIcon from '@material-ui/icons/Close';
import { useContent } from '@backstage/core-components';
import {
  SearchBar,
  SearchResult,
  SearchResultPager,
  useSearch,
} from '@backstage/plugin-search-react';

const useStyles = makeStyles(theme => ({
  title: { display: 'flex', alignItems: 'center', gap: theme.spacing(1) },
  input: { flex: 1 },
  hint: { padding: theme.spacing(4, 1) },
}));

/**
 * Body of the sidebar search modal. Same layout as the stock
 * SidebarSearchModal, with one difference: the stock modal renders
 * "Sorry, no results were found" as soon as it opens, before anything has
 * been searched, because it doesn't query an empty term. That reads as
 * "search is broken". Show a prompt until there's a term to search for.
 */
export const SearchModalContent = ({ toggleModal }: { toggleModal: () => void }) => {
  const classes = useStyles();
  const navigate = useNavigate();
  const { transitions } = useTheme();
  const { focusContent } = useContent();
  const { term } = useSearch();
  const inputRef = useRef<HTMLInputElement>(null);

  // Move focus into the dialog's search box when it opens, like the stock
  // modal, so you can type straight away. A ref rather than the autoFocus
  // prop, which jsx-a11y/no-autofocus rejects wholesale.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleResultClick = useCallback(() => {
    setTimeout(focusContent, transitions.duration.leavingScreen);
  }, [focusContent, transitions]);

  // Read the input itself, not `term`: SearchBar debounces its updates to the
  // search context, so Enter pressed right after typing would otherwise open
  // the full results for the previous query.
  const openFullResults = useCallback(() => {
    const query = inputRef.current?.value ?? term;
    navigate(`/search?query=${encodeURIComponent(query)}`);
    handleResultClick();
  }, [navigate, term, handleResultClick]);

  const hasTerm = term.trim() !== '';

  return (
    <>
      <DialogTitle>
        <Box className={classes.title}>
          <SearchBar
            className={classes.input}
            inputProps={{ ref: inputRef }}
            onSubmit={openFullResults}
          />
          <IconButton aria-label="close" onClick={toggleModal}>
            <CloseIcon />
          </IconButton>
        </Box>
      </DialogTitle>
      <DialogContent>
        {hasTerm ? (
          <>
            <Box display="flex" justifyContent="flex-end">
              <Button
                color="primary"
                endIcon={<ArrowForwardIcon />}
                onClick={openFullResults}
                disableRipple
              >
                View full results
              </Button>
            </Box>
            <Divider />
            <SearchResult onClick={handleResultClick} onKeyDown={handleResultClick} />
          </>
        ) : (
          <Typography className={classes.hint} color="textSecondary">
            Type to search services, APIs, templates and docs.
          </Typography>
        )}
      </DialogContent>
      {hasTerm && (
        <DialogActions>
          <SearchResultPager />
        </DialogActions>
      )}
    </>
  );
};
