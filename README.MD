# nufatfs
The new implementation of the FAT16 / FAT32 filesystem driver for JavaScript.

## Missing features / problems with the library
This library doesn't support LFNs (Long file names).
This library is also quite new, therefore not a lot of testing had been
done on it, and using it might lead to file corruption. Please be careful while using it,
and make frequent backups. If you encounter any problems, please be sure to open an issue
describing the problem, so that they can be fixed.

## API

The API of this library aims to be as flexible as possible, letting everyone use the
"user-friendly" functions of the filesystem, but making directly editing the FAT structures
not only possible, but also not breaking the higher-level compatibility.

The library is split into two parts:
- LowLevelFatFilesystem (as defined in `low-level.ts`)
- FatFilesystem (as defined in `high-level.ts`)


### FatFilesystem
- `open(path: string, writable: boolean = false)`:
  - **Description**: Opens a file specified by the given path.
  - **Parameters**:
    - `path`: The path of the file to open.
    - `writable` (optional): Flag indicating whether to open the file for writing.
  - **Returns**: A `Promise` resolving to a `FatFSFileHandle` representing the opened file, or `null` if the file cannot be opened.

- `create(path: string)`:
  - **Description**: Creates a new file with the specified path.
  - **Parameters**:
    - `path`: The path of the file to create.
  - **Returns**: A `Promise` resolving to a `FatFSFileHandle` representing the created file, or `null` if the file already exists.

- `listDir(path: string)`:
  - **Description**: Lists the contents of a directory specified by the given path.
  - **Parameters**:
    - `path`: The path of the directory to list.
  - **Returns**: A `Promise` resolving to an array of strings representing the names of the directory's contents, or `null` if the directory does not exist.

- `getSizeOf(path: string)`:
  - **Description**: Retrieves the size of a file specified by the given path.
  - **Parameters**:
    - `path`: The path of the file.
  - **Returns**: A `Promise` resolving to the size of the file in bytes, or `null` if the file does not exist.

- `getStats()`:
  - **Description**: Retrieves including total and free clusters and bytes.
  - **Parameters**: None.
  - **Returns**: An object containing total and free cluster and byte counts.

- `delete(path: string)`:
  - **Description**: Deletes the file or directory specified by the given path.
  - **Parameters**:
    - `path`: The path of the file or directory to delete.
  - **Returns**: None.

- `rename(path: string, newPath: string)`:
  - **Description**: Renames or moves a file or directory specified by the given path.
  - **Parameters**:
    - `path`: The current path of the file or directory.
    - `newPath`: The new path to rename or move the file or directory to.
  - **Returns**: None.

- `flushMetadataChanges()`:
  - **Description**: Flushes changes to the file system metadata.
  - **Parameters**: None.
  - **Returns**: A `Promise` resolving when the metadata changes are flushed.

- `getUnderlying()`:
  - **Description**: Retrieves the underlying LowLevelFatFilesystem instance. Use this method if you need to perform lower-level operations on the filesystem
  - **Parameters**: None.
  - **Returns**: The underlying `LowLevelFatFilesystem` instance.

Since `FatFilesystem` has no cache of its own, and only uses the `LowLevelFatFilesystem` instance's methods, it's safe to use the lower-level functions
together with the higher-level ones.

### LowLevelFatFilesystem

**Here be dragons** - Use these functions only if you know what you're doing. They can easily corrupt the filesystem
and cause data loss.

This object shouldn't be created directly, instead it should be retrieved using the higher-level
class' `getUnderlying()` method.

- `getRootDirectoryData()`: 
  - **Description:** Retrieves the contents of the root directory.
  - **Parameters**: None.
  - **Returns:** A Promise resolving to an array of FatFSDirectoryEntry objects representing the root directory data.

- `markAsAltered(entry: CachedDirectory)`: 
  - **Description**: Marks a directory entry as altered, indicating that it needs to be updated during the flush operation.
  - **Parameters**:
    - `entry`: The directory entry to be marked as altered.
  - **Returns**: None.

- `markFatAsAltered()`:
  - **Description**: Marks the FATs as in need of flushing.
  - **Parameters**: None.
  - **Returns**: None.

- `consumeAllDirectoryEntries(data: Uint8Array, includeDeleted = false)`:
  - **Description**: Parses directory entries from raw data and returns an array of directory entries.
  - **Parameters**:
    - `data`: Raw data containing directory entries.
    - `includeDeleted` (optional): Flag indicating whether to include deleted entries in the output.
  - **Returns**: An array of directory entries.

- `getClusterChainFromFAT(initialCluster: number)`:
  - **Description**: Retrieves the cluster chain associated with a given initial cluster from the File Allocation Table (FAT).
  - **Parameters**:
    - `initialCluster`: The initial cluster of the file.
  - **Returns**: An array representing the cluster chain.

- `constructClusterChain(initialCluster: number, enableAllocator = true, limitLength?: number)`:
  - **Description**: Constructs a cluster chain for a file given its initial cluster.
  - **Parameters**:
    - `initialCluster`: The initial cluster of the file.
    - `enableAllocator` (optional): Flag indicating whether to use an allocator for cluster allocation.
    - `limitLength` (optional): Maximum length of the chain (in bytes).
  - **Returns**: A `Chain` object representing the cluster chain.

- `readAndConsumeAllDirectoryEntries(initialCluster: number)`: 
  - **Description**: Reads directory entries from the specified initial cluster and returns them.
  - **Parameters**:
    - `initialCluster`: The initial cluster of the directory.
  - **Returns**: An array of directory entries.

- `readClusters(clusterNumber: number, count: number)`: 
  - **Description**: Reads clusters from the disk.
  - **Parameters**:
    - `clusterNumber`: The number of the first cluster to read.
    - `count`: The number of clusters to read.
  - **Returns**: A `Promise` resolving to the data read from the clusters.

- `writeClusters(clusterNumber: number, data: Uint8Array)`: 
  - **Description**: Writes data to clusters on the disk.
  - **Parameters**:
    - `clusterNumber`: The number of the first cluster to write.
    - `data`: The data to be written.
  - **Returns**: None.

- `redefineClusterChain(initialCluster: number, newChain: number[])`: 
  - **Description**: Redefines the cluster chain for a file with a new chain.
  - **Parameters**:
    - `initialCluster`: The original first cluster of the chain. (Required for when newChain[0] != oldChain[0])
    - `newChain`: The new cluster chain.
  - **Returns**: None.

- `flush()`: 
  - **Description**: Flushes changes to the file system, updating the FAT tables and directory entries.
  - **Parameters**: None.
  - **Returns**: None.

- `traverseEntries(path: string)`: 
  - **Description:** Traverses the file system to find the specified path and returns an array of CachedFatDirectoryEntry objects representing each directory in the path.
  - **Parameters**:
    - `path`: The path to traverse.
  - **Returns:** A Promise resolving to an array of CachedFatDirectoryEntry objects representing each directory in the path, or null if the path is not found.

- `traverse(path: string)`: 
  - **Description:** Traverses the file system to find the specified path and returns the CachedFatDirectoryEntry object representing the last directory in the path.
  - **Parameters**:
    - `path`: The path to traverse.
  - **Returns:** A Promise resolving to the CachedFatDirectoryEntry object representing the last directory in the path, or null if the path is not found.

## Driver API
The Driver interface represents an abstraction for interacting with the underlying storage device,
such as a disk, where the FAT file system is stored. It defines the following properties and methods:
- sectorSize: A number representing the size of each sector on the storage device in bytes. 
  The sector is the smallest unit of storage that can be read from or written to on the device.
  The data passed into `writeSectors`, and returned from `readSectors`'s length must always be a multiple of this value.
- numSectors: A number representing the total number of available sectors on the storage device.
- readSectors(startIndex: number, readSectors: number): A function that reads a specified number of sectors from the
  storage device, starting from the sector at the given startIndex.
  It returns a Promise resolving to a Uint8Array containing the data read from the sectors.
- writeSectors: A nullable function that writes data to the storage device. It takes a startIndex parameter indicating
  the starting sector index where the data should be written and a data parameter containing the data to be written,
  represented as a Uint8Array. If this function is null, it indicates that the storage device is read-only and cannot be written to.

It was meant to be as close to the [`fatfs`](https://github.com/natevw/fatfs)'s driver, but since this project uses Promises instead
of callbacks, it couldn't be used without any changes.
