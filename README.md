# The Stacks

**Find any book on any shelf.**

The Stacks is an Obsidian plugin for a large home library. It was made for a library of about 5,000 books. Each book is a plain Markdown note with properties. The plugin gives you fast search and lists by author, genre and topic. It also keeps shelf locations, checks for duplicates, imports lists, and records your reading by year.

## Start here

1. Install the plugin and turn it on (see [Install](#install)).
2. Click the library icon in the left ribbon. The library opens.
3. Click **Import** to add a list of books, or **Add book** to add one book.
4. Click an author name in any list to see all books by that author.

## The library

- Search by title, author or ISBN.
- Filter by ownership, status, genre, topic, format, room, and signed or special edition.
- Sort by title, author, recently added or recently read.
- Group by author, genre, topic, location, format or status.
- The list shows 100 books at a time, so it stays fast with thousands of books.

Status is **unread**, **reading** or **read**.

## Browse

**Browse** lists every author, genre, topic, location, format and reading year. Each entry shows the number of books and the number you read. Authors are in order by surname. Click an entry to open the library with that filter.

## Format

**Format** is separate from genre and topic. The default formats are Hardcover, Paperback, Mass market, Graphic novel, Comic, Zine, Ebook and Audiobook. You can change the list in the settings.

## Locations and bulk changes

Room and shelf are optional. To move a group of books:

1. Filter the library to the books that moved.
2. Click **Select**, then select books or click **Select all**.
3. Click **Move**, then type the new room and shelf.

**Set** works the same way. It changes the status, format, ownership, genre, topic or signed value of all selected books.

## Books you read but do not own

You can also record audiobooks from a streaming service, library ebooks and borrowed books.

- Click **Log a read** in the library header. The form starts with status **Read**, today's date, and **I own this copy** turned off.
- Type where the book came from in **Where from**, for example Spotify or Libby.
- These books do not show in the shelf lists, Browse or locations.
- These books do show in **Reading** and in the year-end report.
- The first menu in the library changes the list: **On my shelves**, **Read elsewhere** or **Everything**.

## Add books

**Add book:**

- Only the title is necessary.
- A warning shows if the book is already in the library.
- **Look up details** gets the author, year, ISBN and cover from Open Library.
- **Add and add another** keeps the form open. It keeps the room, shelf, format and status.

**Import** reads these formats:

- CSV and TSV files, including Goodreads and LibraryThing exports.
- Markdown tables.
- Markdown lists, such as `- **Title** — Author`.
- Plain lines, such as `Title — Author` or `Title by Author`.

The import has three steps:

1. Choose what each column becomes. You can keep a column as its own property, or ignore it.
2. Set values for the whole batch, for example a room, or "not owned".
3. Look at the preview. It shows the new books, the books already in the library, and the books that repeat in the list.

The plugin writes nothing until you confirm. Each import makes a log note in `Imports/`. The import ignores columns for batch numbers and photo file names. It also removes photo file names from notes.

## Duplicates

Two books are possible duplicates when the title and the first author match. The check ignores subtitles, punctuation, accents and a first "The". It treats "Le Guin, Ursula K." and "Ursula K. Le Guin" as one name. Volume numbers keep "Volume 1" and "Volume 2" apart.

The **Duplicates** tab lists possible pairs. Move the extra copy to the trash, or mark the pair as **Not duplicates**.

## Reading

- **Start reading** and **Mark read** are on every book note.
- Each read date goes in the `read` list, so the plugin keeps rereads. For an old read, type only the year.
- **Read again** on a book that you finished starts a new read. The year-end report counts a read as a reread when it is not the first date in the list.
- The **Reading** tab shows the books you read now, and all books read by year, with a small chart.

## Year-end report

**Year-end report** makes one Markdown note for a year, in `Exports/`. It contains:

- A row of covers for every book you read.
- A summary table: books read, books from your shelves, books read elsewhere, and rereads.
- A "Most read" table: the top format, genre, topic, author, source and decade.
- Highlights: your busiest month, your range, new authors, the oldest and newest books, and rereads.
- Each book by month, with its cover, format, source, genre, date and the note from your reading log.
- Tables by format, genre and topic.

Covers use HTML `<img>` tags. They show in Obsidian, on GitHub, and in most newsletter tools.

## Book notes

Each note starts with a bar. The bar shows the status, format, location or source, and signed or special edition. It also has buttons for the next actions. Under the bar, `## Notes` is for your own notes. `## Reading log` collects the dates when you start and finish the book.

**More by this author** lists the other books by the same author.

## Show a list in any note

````markdown
```stacks
show: reading
```
````

| Option | Result |
| --- | --- |
| `show: book` | The bar for a book note |
| `show: reading` | The books you read now |
| `year: 2026` or `show: year` | The books read in that year |
| `author: Ursula K. Le Guin` | All books by that author |
| `genre: Poetry` or `topic: hockey` | All books in a genre or topic |
| `room: Office` or `shelf: A` | All books in a location |
| `show: signed` | Signed and special editions |

## Commands

| Command | Result |
| --- | --- |
| Open the library | Opens the main view |
| Add a book | Opens the add form |
| Log a book I read but don't own | Opens the add form for a book you do not own |
| Import books from a file or list | Opens the import |
| Start reading this book | Sets the open book to "reading" |
| Mark this book read | Records the date you finished |
| Move this book | Changes the room and shelf |
| Find a cover for this book | Searches Open Library |
| Review possible duplicates | Opens the Duplicates tab |
| Export the library as CSV | Makes a CSV that the import can read again |
| Year-end report | Makes the report for a year |

The plugin sets no hotkeys.

## Settings

- Open the library when the vault opens.
- Show covers in lists.
- Books per page: 100 by default.
- Status for new books.
- Formats list.
- Folders: Books, Import logs and Exports.
- Forget the pairs marked "Not duplicates".

## Book properties

| Property | Values |
| --- | --- |
| `title`, `author` | text. Use `;` or `&` between authors. |
| `status` | `unread`, `reading`, `read` |
| `genre`, `topics` | lists |
| `format` | text, from the Formats list |
| `owned` | true or false. No value means true. |
| `source` | where you got a book that you do not own |
| `room`, `shelf` | text |
| `signed` | true or false |
| `edition` | text, for a special edition |
| `isbn`, `year`, `cover`, `link` | text |
| `read` | a list of dates or years |
| `started`, `added` | dates |

## Network use

The Stacks connects to [Open Library](https://openlibrary.org) only when you look up details or search for a cover. The plugin has no accounts, no telemetry and no ads. It does not change files outside your vault.

## Install

**Manual install:**

1. Download `main.js`, `manifest.json` and `styles.css` from the latest release.
2. Put them in `<your vault>/.obsidian/plugins/the-stacks/`.
3. In Obsidian, open **Settings → Community plugins** and turn on **The Stacks**.

**With BRAT:** add `jenniferlynparsons/the-stacks` as a beta plugin.

The plugin works on desktop and mobile.

## License

MIT
