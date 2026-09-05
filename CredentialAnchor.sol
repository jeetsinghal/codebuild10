// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract CredentialAnchor {
    struct Proof { bytes32 documentHash; uint64 timestamp; address sender; string credentialId; }
    mapping(bytes32 => Proof) public proofs;
    event CredentialAnchored(bytes32 indexed documentHash, string credentialId, uint256 timestamp, address indexed sender);

    function anchor(bytes32 documentHash, string calldata credentialId) external {
        require(proofs[documentHash].timestamp == 0, "Already anchored");
        proofs[documentHash] = Proof(documentHash, uint64(block.timestamp), msg.sender, credentialId);
        emit CredentialAnchored(documentHash, credentialId, block.timestamp, msg.sender);
    }

    function verify(bytes32 documentHash) external view returns (bool, uint64, address, string memory) {
        Proof memory p = proofs[documentHash];
        return (p.timestamp != 0, p.timestamp, p.sender, p.credentialId);
    }
}
