pragma solidity 0.4.26;

import "./BasicSnapshotToken.sol";
import "./Helpers/MTokenMint.sol";


/// @title basic snapshot token with facitilites to generate and destroy tokens
/// @dev implementes MTokenMint, does not expose any public functions that create/destroy tokens
contract MintableSnapshotToken is
    BasicSnapshotToken,
    MTokenMint
{

    ////////////////////////
    // Constructor
    ////////////////////////

    /// @notice Constructor to create a MintableSnapshotToken
    /// @param parentToken Address of the parent token, set to 0x0 if it is a
    ///  new token
    constructor(
        IClonedTokenParent parentToken,
        uint256 parentSnapshotId
    )
        BasicSnapshotToken(parentToken, parentSnapshotId)
        internal
    {}

    ////////////////////////
    // Internal functions
    ////////////////////////

    //
    // Implements MTokenMint
    //

    /// @notice Generates `amount` tokens that are assigned to `owner`
    /// @param owner The address that will be assigned the new tokens
    /// @param amount The quantity of tokens generated
    function mGenerateTokens(address owner, uint256 amount)
        internal
    {
        // never create for address 0
        require(owner != address(0));
        // block changes in clone that points to future/current snapshots of patent token
        require(parentToken() == address(0) || parentSnapshotId() < parentToken().currentSnapshotId());

        uint256 curTotalSupply = totalSupply();
        uint256 newTotalSupply = curTotalSupply + amount;
        require(newTotalSupply >= curTotalSupply); // Check for overflow

        uint256 previousBalanceTo = balanceOf(owner);
        uint256 newBalanceTo = previousBalanceTo + amount;
        assert(newBalanceTo >= previousBalanceTo); // Check for overflow

        setValue(_totalSupplyValues, newTotalSupply);
        setValue(_balances[owner], newBalanceTo);

        emit Transfer(0, owner, amount);
    }

    /// @notice Burns `amount` tokens from `owner`
    /// @param owner The address that will lose the tokens
    /// @param amount The quantity of tokens to burn
    function mDestroyTokens(address owner, uint256 amount)
        internal
    {
        // block changes in clone that points to future/current snapshots of patent token
        require(parentToken() == address(0) || parentSnapshotId() < parentToken().currentSnapshotId());

        uint256 curTotalSupply = totalSupply();
        require(curTotalSupply >= amount);

        uint256 previousBalanceFrom = balanceOf(owner);
        require(previousBalanceFrom >= amount);

        uint256 newTotalSupply = curTotalSupply - amount;
        uint256 newBalanceFrom = previousBalanceFrom - amount;
        setValue(_totalSupplyValues, newTotalSupply);
        setValue(_balances[owner], newBalanceFrom);

        emit Transfer(owner, 0, amount);
    }
}
